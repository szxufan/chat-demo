/**
 * OpenAI 兼容接口（/v1/chat/completions）协议类型，只取本应用用到的部分。
 * 搜索与链接阅读由客户端工具循环执行（/v1/tools/search|fetch），见 services/api/tools.ts。
 * 「本地持久化形状」一节与 wire 协议无关：IndexedDB 与历史归档沿用这些结构，边界处做映射。
 */

/** 模型 id 来自上游 GET /v1/models，不再限定固定名单 */
export type ChatModel = string

/** GET /v1/models 返回的模型条目，只取本应用用到的字段；能力字段可能缺省 */
export type ModelInfo = {
  id: ChatModel
  /** 支持的端点类型；含 openai 的才是聊天模型 */
  supported_endpoint_types?: string[]
  context_length?: number
  max_output_tokens?: number
  support_image_input?: boolean
  support_video_input?: boolean
  /** 支持的思考强度级别（如 low/high/max）；缺省表示不支持选择强度 */
  reasoning_options?: string[]
}

// ---------- 本地持久化形状 ----------

/** 正文引用来源；当前由模型正文内的 [citation:N] 角标配合来源列表渲染，此结构保留供归档兼容 */
export type TextCitation = {
  type: 'web_search_result_location'
  url: string
  /** 查不到标题时为 null */
  title: string | null
  cited_text: string
  encrypted_index: string
}

/** 服务端工具调用的 kind，区分文字搜索、图搜及边想边搜；客户端循环合成时沿用 */
export type ServerToolKind =
  | 'search'
  | 'deep_search'
  | 'read_link'
  | 'image_search'
  | 'deep_image_search'

/** server_tool_use 的四种动作，input 结构由 action 决定 */
export type ServerToolInput =
  | { action: 'search'; query?: string; queries: string[] }
  | { action: 'open_page'; url: string }
  /** 找不到关联页面时 url 为空串 */
  | { action: 'find_in_page'; url: string; pattern: string }
  | { action: 'read_link'; url: string }

/** 工具调用块：客户端循环里由模型的 tool_calls 合成，id 为 tool_call id */
export type ServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'deepseek_web_search' | 'deepseek_read_url'
  input: ServerToolInput
  caller: { type: 'direct' }
  kind: ServerToolKind
}

export type WebSearchResult = {
  type: 'web_search_result'
  title: string
  url: string
  /** 图搜召回的原站图片地址，可能缺省；仅保存，当前不展示图片。 */
  image_url?: string
  /** 可直接展示的网页摘要 */
  snippet: string
  /** 站点图标 URL；无法取得注册域名时为 null */
  site_icon: string | null
  /** 无站点名称时为 null */
  site_name: string | null
  /** 历史归档不带加密摘要，导入时为空串 */
  encrypted_content: string
  /** RFC 3339 UTC 时间，没有发布时间时为 null */
  page_age: string | null
}

export type WebSearchToolResultError = {
  type: 'web_search_tool_result_error'
  error_code: 'unavailable'
}

export type WebSearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  /** 成功且无可见结果时为 []；失败时为只含一个错误项的数组 */
  content: (WebSearchResult | WebSearchToolResultError)[]
  kind: 'search' | 'deep_search' | 'image_search' | 'deep_image_search'
}

export type WebFetchResult = {
  type: 'web_fetch_result'
  url: string
  content: {
    type: 'document'
    /** 客户端抓取的网页明文正文 */
    source: { type: 'text'; media_type: 'text/plain'; data: string }
    title: string | null
  }
  /** 抓取时间等原始日期字符串；缺省为 null */
  published_at: string | null
}

export type WebFetchToolResultError = {
  type: 'web_fetch_tool_result_error'
  /** url_not_accessible 抓取失败；url_not_allowed 被拦截；unavailable 服务异常或未完成就结束 */
  error_code: 'url_not_accessible' | 'url_not_allowed' | 'unavailable'
}

export type WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: WebFetchResult | WebFetchToolResultError
  kind: 'read_link' | 'deep_search'
  /** 旧版服务端加密页面签名；OpenAI 兼容面不再产生，仅历史数据可能携带 */
  signature?: string
}

export type ServerToolBlock =
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock

/** 本地结束原因形状；边界处由 OpenAI finish_reason 映射 */
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

export type StopDetails = { type: 'refusal'; category: null; explanation: null }

/** 本地用量形状；边界处由 OpenAI usage 映射，跨工具轮累加 */
export type MessageUsage = {
  /** 未命中缓存的输入 Token */
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  /** 仅当请求声明了搜索工具时出现 */
  server_tool_use?: { web_search_requests: number; tool_search: number }
}

// ---------- OpenAI 兼容请求 ----------

/** user 消息内容块：文本或内联 base64 图片 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 模型发出的客户端工具调用；arguments 为 JSON 字符串，流式按 index 增量下发 */
export type ChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  index?: number
}

/** tool_calls 流式增量：首片带 id/name，后续片仅 index 与 arguments 片段 */
export type ChatToolCallDelta = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export type ChatMessageParam =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** 搜索/链接阅读声明为 function 工具：模型发 tool_calls，应用执行后以 tool 消息回传 */
export type ChatFunctionTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ChatCompletionRequest = {
  model: ChatModel
  messages: ChatMessageParam[]
  stream: true
  stream_options?: { include_usage: boolean }
  thinking?: { type: 'enabled' | 'disabled' }
  /** 思考强度，取值来自模型的 reasoning_options；显式 thinking.type 优先决定开关 */
  reasoning_effort?: string
  safety_check?: { level: 'high' }
  tools?: ChatFunctionTool[]
  max_tokens?: number
}

// ---------- OpenAI 兼容响应 ----------

export type OpenAIUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** 流式 chunk：delta 增量；结束 chunk 带 finish_reason；usage 在 choices 为空的独立 chunk */
export type ChatCompletionChunk = {
  id: string
  choices: {
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: ChatToolCallDelta[]
    }
    finish_reason: string | null
  }[]
  usage?: OpenAIUsage | null
}

/** 非 2xx 响应体；流中出现只含 error 的无名 data 帧时同样按此解析 */
export type ApiErrorBody = {
  error: {
    message: string
    type?: string
    param?: string | null
    code?: string | null
  }
}
