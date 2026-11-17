import { ApiError, API_ORIGIN, request } from '../api/client.js'
import { readServerSentEvents } from '../api/sse.js'

/**
 * MCP 客户端（Streamable HTTP，免配置）：
 * 端点固定为网关同源 /v1/mcp，鉴权复用设置中的 API Key（Authorization: Bearer）。
 * 网关为无状态实现，tools/list 与 tools/call 可直接调用，无需 initialize 会话；
 * 且其 CORS 不允许 Mcp-Session-Id 请求头，因此不发送会话头。
 */
const MCP_URL = `${API_ORIGIN}/v1/mcp`

/** 工具调用超时：视频生成为长任务，与调试配置一致留足等待 */
const TOOL_TIMEOUT_MS = 4_000_000
/** tools/list 等普通请求的超时 */
const REQUEST_TIMEOUT_MS = 60_000

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** MCP 工具结果内容块，只取本应用用到的类型 */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | {
      type: 'resource'
      resource: { uri: string; mimeType?: string; text?: string; blob?: string }
    }

export type McpCallResult = {
  content: McpContent[]
  isError?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 网关可能在 JSON-RPC 文档前拼接上游原始 JSON（如视频任务对象），
 * 整体解析失败时退回最后一个 {"jsonrpc" 开头的片段。
 */
const parseRpcDocument = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    const index = text.lastIndexOf('{"jsonrpc"')
    if (index >= 0) {
      try {
        return JSON.parse(text.slice(index))
      } catch {
        // 片段仍不完整时按协议错误处理
      }
    }
    throw new ApiError('protocol', 'Unexpected MCP response')
  }
}

/** 合并用户中止与超时信号；构建目标不支持 AbortSignal.any/timeout，手动实现。 */
const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('MCP request timed out')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort)
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

let requestId = 0

/** 发送一次 JSON-RPC 请求；响应可能是纯 JSON 或 SSE，统一取出 result/error。 */
const rpc = async (
  method: string,
  params: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Record<string, unknown>> => {
  const id = ++requestId
  const timed = withTimeout(signal, timeoutMs)
  try {
    const response = await request(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: timed.signal,
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    let payload: unknown
    if (contentType.includes('text/event-stream')) {
      if (!response.body) {
        throw new ApiError('protocol', 'MCP stream response has no body')
      }
      for await (const { data } of readServerSentEvents(response.body, timed.signal)) {
        const document = parseRpcDocument(data)
        if (isRecord(document) && ('result' in document || 'error' in document)) {
          payload = document
          break
        }
      }
      if (payload === undefined) {
        throw new ApiError('interrupted', '')
      }
    } else {
      payload = parseRpcDocument(await response.text())
    }
    if (!isRecord(payload)) {
      throw new ApiError('protocol', 'Unexpected MCP response')
    }
    if (isRecord(payload.error)) {
      const message =
        typeof payload.error.message === 'string' ? payload.error.message : 'MCP request failed'
      throw new ApiError('protocol', message)
    }
    if (!isRecord(payload.result)) {
      throw new ApiError('protocol', 'MCP response has no result')
    }
    return payload.result
  } catch (error) {
    // 用户中止原样抛出，由生成流程按「已停止」收尾；超时转为网络错误。
    if (signal?.aborted) {
      throw error
    }
    if (timed.signal.aborted) {
      throw new ApiError('network', 'MCP request timed out')
    }
    throw error
  } finally {
    timed.dispose()
  }
}

const readToolInfo = (value: unknown): McpToolInfo | null => {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) {
    return null
  }
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : undefined,
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : undefined,
  }
}

/** 发现工具列表，处理 cursor 分页 */
export const listMcpTools = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<McpToolInfo[]> => {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  do {
    const result = await rpc(
      'tools/list',
      cursor ? { cursor } : {},
      apiKey,
      signal,
      REQUEST_TIMEOUT_MS
    )
    if (Array.isArray(result.tools)) {
      for (const item of result.tools) {
        const info = readToolInfo(item)
        if (info) {
          tools.push(info)
        }
      }
    }
    cursor =
      typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
  } while (cursor)
  return tools
}

const readContent = (value: unknown): McpContent | null => {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text }
  }
  if (
    value.type === 'image' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'image', data: value.data, mimeType: value.mimeType }
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    return {
      type: 'resource_link',
      uri: value.uri,
      name: typeof value.name === 'string' ? value.name : undefined,
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    }
  }
  if (
    value.type === 'resource' &&
    isRecord(value.resource) &&
    typeof value.resource.uri === 'string'
  ) {
    return {
      type: 'resource',
      resource: {
        uri: value.resource.uri,
        mimeType: typeof value.resource.mimeType === 'string' ? value.resource.mimeType : undefined,
        text: typeof value.resource.text === 'string' ? value.resource.text : undefined,
        blob: typeof value.resource.blob === 'string' ? value.resource.blob : undefined,
      },
    }
  }
  return null
}

/** 调用工具；长任务（视频生成）在超时内阻塞等待，用户中止随时生效。 */
export const callMcpTool = async (
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpCallResult> => {
  const result = await rpc('tools/call', { name, arguments: args }, apiKey, signal, TOOL_TIMEOUT_MS)
  const content = Array.isArray(result.content)
    ? result.content.map(readContent).filter((item): item is McpContent => item !== null)
    : []
  return { content, isError: result.isError === true }
}
