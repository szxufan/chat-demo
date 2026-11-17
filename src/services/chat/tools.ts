import type {
  ChatFunctionTool,
  ChatToolCall,
  ServerToolBlock,
  ServerToolInput,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchToolResultBlock,
} from '../api/types.js'
import { fetchUrl, searchWeb } from '../api/tools.js'
import type { ReplyBlock } from './types.js'

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
  /** 本地工具调用与结果块，追加进回复供 UI 展示与归档 */
  blocks: ServerToolBlock[]
  /** 回传给模型的 tool 消息内容 */
  message: string
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
  signal?: AbortSignal
): Promise<ToolExecution> => {
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

/** 由本地调用块合成历史回传的 tool_calls；只保留有结果块的调用 */
export const toolCallsForHistory = (blocks: ReplyBlock[]): ChatToolCall[] => {
  const resultIds = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result'
        ? [block.tool_use_id]
        : []
    )
  )
  return blocks.flatMap((block) =>
    block.type === 'server_tool_use' && resultIds.has(block.id)
      ? [
          {
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          },
        ]
      : []
  )
}

/** 由结果块重建 tool 消息内容，与执行时回传的格式一致 */
export const toolMessageForHistory = (blocks: ReplyBlock[], toolUseId: string): string | null => {
  const result = blocks.find(
    (block) =>
      (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') &&
      block.tool_use_id === toolUseId
  )
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
