import type {
  ChatFunctionTool,
  ChatToolCall,
  ServerToolInput,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchToolResultBlock,
} from '../api/types.js'
import { fetchUrl, searchWeb } from '../api/tools.js'
import { callMcpTool } from '../mcp/client.js'
import { extractMedia, nameFromUrl, persistRemoteMedia } from '../mcp/media.js'
import type { McpToolset } from '../mcp/tools.js'
import { uploadMcpImage } from '../mcp/upload.js'
import { isVideoSubmitTool, pollVideoTask, readVideoTask } from '../mcp/videoTask.js'
import * as db from './db.js'
import type { McpMedia, McpToolResultBlock, McpToolUseBlock, ReplyBlock } from './types.js'

/** 回传给模型的网页明文正文长度上限，控制上下文开销 */
const FETCH_CONTENT_LIMIT = 20000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const webSearchTool: ChatFunctionTool = {
  type: 'function',
  function: {
    name: 'deepseek_web_search',
    description: 'Search the web for up-to-date information',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
}

const readUrlTool: ChatFunctionTool = {
  type: 'function',
  function: {
    name: 'deepseek_read_url',
    description: 'Read the full content of a URL mentioned in the user message',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to read' } },
      required: ['url'],
    },
  },
}

/** 搜索/链接阅读声明为 function 工具：模型发 tool_calls，应用执行后以 tool 消息回传。链接阅读始终可用。 */
export const searchTools = (search: boolean): ChatFunctionTool[] =>
  search ? [webSearchTool, readUrlTool] : [readUrlTool]

/** 解析 tool_calls 的 arguments 为本地 input；无法识别时返回 null */
export const parseToolInput = (call: ChatToolCall): ServerToolInput | null => {
  let args: unknown
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    return null
  }
  if (!isRecord(args)) {
    return null
  }
  if (call.function.name === 'deepseek_read_url') {
    return typeof args.url === 'string' && args.url ? { action: 'read_link', url: args.url } : null
  }
  const queries = Array.isArray(args.queries)
    ? args.queries.filter((query): query is string => typeof query === 'string')
    : typeof args.query === 'string'
      ? [args.query]
      : []
  return queries.length > 0 ? { action: 'search', queries } : null
}

export type ToolExecution = {
  /** 本地结果块，追加进回复供 UI 展示与归档；MCP 调用块已经由钩子先行追加 */
  blocks: ReplyBlock[]
  /** 回传给模型的 tool 消息内容 */
  message: string
}

/** MCP 执行上下文：路由表与进度钩子由生成流程提供 */
export type McpExecution = {
  route: McpToolset['route']
  /** 调用块立即入列，长任务期间 UI 可见进行态 */
  onCallBlock: (block: McpToolUseBlock) => void
  onProgress: (toolUseId: string, progress: string) => void
}

const searchPayload = (hits: Awaited<ReturnType<typeof searchWeb>>) =>
  JSON.stringify({
    results: hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      site_name: hit.site_name,
      site_icon: hit.site_icon,
      date: hit.page_age,
    })),
  })

/** 执行一次工具调用：合成调用块与结果块；失败合成错误变体，不中断回复 */
export const executeToolCall = async (
  apiKey: string,
  call: ChatToolCall,
  signal?: AbortSignal,
  mcp?: McpExecution
): Promise<ToolExecution> => {
  if (mcp && mcp.route.has(call.function.name)) {
    return executeMcpToolCall(apiKey, call, signal, mcp)
  }
  const input = parseToolInput(call)
  const isRead = input?.action === 'read_link'
  const callBlock: ServerToolUseBlock = {
    type: 'server_tool_use',
    id: call.id,
    name: isRead ? 'deepseek_read_url' : 'deepseek_web_search',
    input: input ?? { action: 'search', queries: [] },
    caller: { type: 'direct' },
    kind: isRead ? 'read_link' : 'search',
  }
  if (input?.action === 'read_link') {
    try {
      const page = await fetchUrl(apiKey, input.url, signal)
      const content = page.content.slice(0, FETCH_CONTENT_LIMIT)
      const result: WebFetchToolResultBlock = {
        type: 'web_fetch_tool_result',
        tool_use_id: call.id,
        kind: 'read_link',
        content: {
          type: 'web_fetch_result',
          url: input.url,
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: content },
            title: page.title,
          },
          published_at: null,
        },
      }
      return {
        blocks: [callBlock, result],
        message: JSON.stringify({ content, title: page.title }),
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      const result: WebFetchToolResultBlock = {
        type: 'web_fetch_tool_result',
        tool_use_id: call.id,
        kind: 'read_link',
        content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
      }
      return { blocks: [callBlock, result], message: JSON.stringify({ content: '', title: null }) }
    }
  }
  const queries = input?.action === 'search' ? input.queries : []
  try {
    const lists = await Promise.all(queries.map((query) => searchWeb(apiKey, query, signal)))
    const seen = new Set<string>()
    const hits = lists.flat().filter((hit) => {
      if (seen.has(hit.url)) {
        return false
      }
      seen.add(hit.url)
      return true
    })
    const result: WebSearchToolResultBlock = {
      type: 'web_search_tool_result',
      tool_use_id: call.id,
      kind: 'search',
      content: hits.map((hit) => ({
        type: 'web_search_result' as const,
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        site_icon: hit.site_icon,
        site_name: hit.site_name,
        encrypted_content: '',
        page_age: hit.page_age,
      })),
    }
    return { blocks: [callBlock, result], message: searchPayload(hits) }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    const result: WebSearchToolResultBlock = {
      type: 'web_search_tool_result',
      tool_use_id: call.id,
      kind: 'search',
      content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
    }
    return { blocks: [callBlock, result], message: searchPayload([]) }
  }
}

/** 各工具接受图片引用的参数字段；模型传入附件 id、代理 URL 或上传 id，客户端统一解析 */
const IMAGE_REF_FIELDS: Record<string, string[]> = {
  generate_image: ['image_ids'],
  generate_video_from_frames: ['first_frame_id', 'last_frame_id'],
  generate_video_from_reference: ['image_ids'],
}

/**
 * 解析单个图片引用为网关可接受的形式：
 * 本地附件 id 读原件后走 mcp-upload 换临时 id；generate_image 的远程图片同样抓取后上传
 * （其上游只认上传存储引用）；视频工具按文档直接接受代理 URL。
 */
const resolveImageRef = async (
  apiKey: string,
  toolName: string,
  ref: string,
  signal?: AbortSignal
): Promise<string> => {
  if (!ref || ref.startsWith('data:')) {
    return ref
  }
  const local = await db.loadFile(ref).catch(() => undefined)
  if (local) {
    const uploaded = await uploadMcpImage(apiKey, local, `${ref.slice(0, 16)}.png`, signal)
    return uploaded.id
  }
  if (/^https?:/.test(ref) && toolName === 'generate_image') {
    const response = await fetch(ref, { signal })
    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status}`)
    }
    const blob = await response.blob()
    const uploaded = await uploadMcpImage(apiKey, blob, nameFromUrl(ref, 'image'), signal)
    return uploaded.id
  }
  return ref
}

const resolveImageRefs = async (
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) => {
  for (const field of IMAGE_REF_FIELDS[toolName] ?? []) {
    const value = args[field]
    if (typeof value === 'string') {
      args[field] = await resolveImageRef(apiKey, toolName, value, signal)
    } else if (Array.isArray(value)) {
      args[field] = await Promise.all(
        value.map((item) =>
          typeof item === 'string' ? resolveImageRef(apiKey, toolName, item, signal) : item
        )
      )
    }
  }
}

/** 回传模型的 MCP 结果：文本 + 媒体地址 + 可编辑图片 id；不含 base64，控制上下文开销 */
const buildMcpMessage = (text: string, media: McpMedia[], imageIds: string[], isError: boolean) => {
  const payload: Record<string, unknown> = {}
  if (text) {
    payload.text = text
  }
  if (media.length > 0) {
    payload.media = media.map((item) => ({
      kind: item.kind,
      ...(item.url ? { url: item.url } : {}),
      name: item.name,
    }))
  }
  if (imageIds.length > 0) {
    payload.image_ids = imageIds
  }
  if (isError) {
    payload.is_error = true
  }
  return JSON.stringify(payload)
}

/**
 * 执行 MCP 工具调用：调用块经钩子立即入列；视频提交类工具由客户端轮询到终态；
 * 媒体提取落盘后合成结果块。失败合成 is_error 结果交模型恢复，不中断回复。
 */
const executeMcpToolCall = async (
  apiKey: string,
  call: ChatToolCall,
  signal: AbortSignal | undefined,
  mcp: McpExecution
): Promise<ToolExecution> => {
  const originalName = mcp.route.get(call.function.name) ?? call.function.name
  let input: unknown
  try {
    input = JSON.parse(call.function.arguments)
  } catch {
    input = {}
  }
  mcp.onCallBlock({
    type: 'mcp_tool_use',
    id: call.id,
    name: call.function.name,
    input,
    startedAt: Date.now(),
  })
  const fail = (message: string): ToolExecution => {
    const payload = JSON.stringify({ error: message })
    const block: McpToolResultBlock = {
      type: 'mcp_tool_result',
      tool_use_id: call.id,
      message: payload,
      media: [],
      isError: true,
      endedAt: Date.now(),
    }
    return { blocks: [block], message: payload }
  }
  try {
    const args: Record<string, unknown> =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? { ...(input as Record<string, unknown>) }
        : {}
    await resolveImageRefs(apiKey, originalName, args, signal)
    let result = await callMcpTool(apiKey, originalName, args, signal)
    if (!result.isError && isVideoSubmitTool(originalName)) {
      const task = readVideoTask(result)
      if (task?.task_id) {
        result = await pollVideoTask(apiKey, task.task_id, signal, (progress) =>
          mcp.onProgress(call.id, progress)
        )
      }
    }
    signal?.throwIfAborted()
    const { media, text } = await extractMedia(result.content, signal)
    // 视频任务的媒体地址在任务 JSON 里，不在 MCP 媒体内容块中
    if (isVideoSubmitTool(originalName) || originalName === 'get_video_task') {
      const task = readVideoTask(result)
      const url = task?.result_url || task?.proxy_url
      if (url && !media.some((item) => item.kind === 'video')) {
        media.push(await persistRemoteMedia(url, 'video', 'video/mp4', signal))
      }
    }
    // 生成的图片补传 mcp-upload，给模型可继续编辑的临时 id 与兜底地址
    const imageIds: string[] = []
    for (const item of media) {
      if (item.kind === 'image' && item.fileId && !item.url) {
        const blob = await db.loadFile(item.fileId).catch(() => undefined)
        if (blob) {
          try {
            const uploaded = await uploadMcpImage(apiKey, blob, item.name, signal)
            item.url = uploaded.url
            imageIds.push(uploaded.id)
          } catch {
            // 补传失败不影响展示，模型仍可用文本里的代理地址
          }
        }
      }
    }
    signal?.throwIfAborted()
    const isError = result.isError === true
    const message = buildMcpMessage(text, media, imageIds, isError)
    const block: McpToolResultBlock = {
      type: 'mcp_tool_result',
      tool_use_id: call.id,
      message,
      media,
      isError: isError || undefined,
      endedAt: Date.now(),
    }
    return { blocks: [block], message }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** 由本地调用块合成历史回传的 tool_calls；只保留有结果块的调用 */
export const toolCallsForHistory = (blocks: ReplyBlock[]): ChatToolCall[] => {
  const resultIds = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result' ||
      block.type === 'mcp_tool_result'
        ? [block.tool_use_id]
        : []
    )
  )
  return blocks.flatMap((block) => {
    if (block.type === 'server_tool_use' && resultIds.has(block.id)) {
      return [
        {
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        },
      ]
    }
    if (block.type === 'mcp_tool_use' && resultIds.has(block.id)) {
      return [
        {
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        },
      ]
    }
    return []
  })
}

/** 由结果块重建 tool 消息内容，与执行时回传的格式一致 */
export const toolMessageForHistory = (blocks: ReplyBlock[], toolUseId: string): string | null => {
  const result = blocks.find(
    (block) =>
      (block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        block.type === 'mcp_tool_result') &&
      block.tool_use_id === toolUseId
  )
  if (result?.type === 'mcp_tool_result') {
    return result.message
  }
  if (result?.type === 'web_search_tool_result') {
    return JSON.stringify({
      results: result.content.flatMap((item) =>
        item.type === 'web_search_result'
          ? [
              {
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                site_name: item.site_name,
                site_icon: item.site_icon,
                date: item.page_age,
              },
            ]
          : []
      ),
    })
  }
  if (result?.type === 'web_fetch_tool_result') {
    return result.content.type === 'web_fetch_result'
      ? JSON.stringify({
          content: result.content.content.source.data,
          title: result.content.content.title,
        })
      : JSON.stringify({ content: '', title: null })
  }
  return null
}
