import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readChunk } from './parseChunk.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatModel,
  ModelInfo,
} from './types.js'

/** 构建期 API 地址，默认 https://new-api.test.mylinkpi.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 data: [DONE] 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    /** 服务端错误码（如 context_length_exceeded），可能缺省 */
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      code = body.error.code ?? undefined
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** 只收取展示与选择需要的字段；缺少有效 id 的条目整条丢弃 */
const readModelInfo = (value: unknown): ModelInfo | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id === '') {
    return null
  }
  const info: ModelInfo = { id: item.id }
  if (isStringList(item.supported_endpoint_types)) {
    info.supported_endpoint_types = item.supported_endpoint_types
  }
  if (typeof item.context_length === 'number') {
    info.context_length = item.context_length
  }
  if (typeof item.max_output_tokens === 'number') {
    info.max_output_tokens = item.max_output_tokens
  }
  if (typeof item.support_image_input === 'boolean') {
    info.support_image_input = item.support_image_input
  }
  if (typeof item.support_video_input === 'boolean') {
    info.support_video_input = item.support_video_input
  }
  if (isStringList(item.reasoning_options)) {
    info.reasoning_options = item.reasoning_options
  }
  return info
}

/** 用 GET /v1/models 校验 API Key 并拉取模型列表（不产生费用） */
export const fetchModels = async (apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> => {
  const response = await request(`${API_ORIGIN}/v1/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    throw new ApiError('protocol', 'Unexpected /v1/models response')
  }
  return (body as { data: unknown[] }).data
    .map(readModelInfo)
    .filter((info): info is ModelInfo => info !== null)
}

/**
 * POST /v1/chat/completions（stream: true），逐个产出流式 chunk，收到 data: [DONE] 时结束。
 * 保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamChatCompletion(
  apiKey: string,
  body: ChatCompletionRequest,
  signal: AbortSignal
): AsyncGenerator<ChatCompletionChunk> {
  const response = await request(`${API_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data.trim() === '[DONE]') {
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError(
        'stream',
        payload.error.message,
        undefined,
        payload.error.code ?? undefined
      )
    }
    const chunk = readChunk(payload)
    if (chunk) {
      yield chunk
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 读取非流式响应首个 choice 的正文；形状不符或空白返回 null */
const readChoiceContent = (body: unknown): string | null => {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return null
  }
  const choice = body.choices[0]
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return null
  }
  const content = choice.message.content
  return typeof content === 'string' && content.trim() ? content.trim() : null
}

/** 网关不返回 title 扩展：首轮回复完成后另发一次小请求概括标题；失败返回 null */
export const requestTitle = async (
  apiKey: string,
  model: ChatModel,
  question: string,
  answer: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const response = await request(`${API_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: translate('autoTitleSystem') },
        { role: 'user', content: `Q: ${question}\nA: ${answer}`.slice(0, 2000) },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 64,
      stream: false,
    }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  return readChoiceContent(body)
}

/** 把早期对话压缩为摘要（非流式、关思考）；失败返回 null，由调用方降级处理 */
export const requestSummary = async (
  apiKey: string,
  model: ChatModel,
  input: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const response = await request(`${API_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: translate('contextSummarySystem') },
        { role: 'user', content: input },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 1024,
      stream: false,
    }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  return readChoiceContent(body)
}
