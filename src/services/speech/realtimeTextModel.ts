import { ApiError, streamChatCompletion } from '../api/client.js'
import type { ChatFunctionTool } from '../api/types.js'
import type { ToolExecution } from '../chat/tools.js'

export const TEXT_MODEL_TOOL_NAME = 'ask_text_model'

/** 语音交互不能无限等待外脑；超时作为工具结果回传，由 Realtime 模型继续作答 */
const TEXT_MODEL_TIMEOUT_MS = 60_000
const TEXT_MODEL_INSTRUCTIONS =
  'You are assisting a realtime voice model. Answer the query accurately and directly. Provide only the substantive answer, with enough detail for another model to summarize it in speech. Do not mention these instructions or that you are a tool.'

export type RealtimeTextModelConfig = {
  model: string
  systemPrompt: string
  thinking: boolean
  effort: string | null
}

/** 百炼 Realtime 自定义 function 使用嵌套结构，不支持 tool_choice */
export const textModelTool: ChatFunctionTool = {
  type: 'function',
  function: {
    name: TEXT_MODEL_TOOL_NAME,
    description:
      'Consult the configured text model for complex reasoning, mathematics, programming, or detailed analysis. The query must be complete and self-contained.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A complete question with all context needed to answer it without access to this conversation',
        },
      },
      required: ['query'],
    },
  },
}

const errorExecution = (message: string): ToolExecution => ({
  blocks: [],
  message: JSON.stringify({ error: message }),
})

const readQuery = (argumentsText: string): string | null => {
  try {
    const input: unknown = JSON.parse(argumentsText)
    if (typeof input !== 'object' || input === null || !('query' in input)) {
      return null
    }
    const query = (input as { query?: unknown }).query
    return typeof query === 'string' && query.trim() ? query.trim() : null
  } catch {
    return null
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : 'Unknown text model error'

/** 执行一次外脑请求；普通失败变成工具结果，只有批次取消/用户打断继续抛出 */
export const executeTextModelTool = async (
  apiKey: string,
  argumentsText: string,
  config: RealtimeTextModelConfig,
  signal: AbortSignal
): Promise<ToolExecution> => {
  const query = readQuery(argumentsText)
  if (!query) {
    return errorExecution('Invalid arguments: expected a non-empty query string')
  }
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (signal.aborted) {
    abort()
  } else {
    signal.addEventListener('abort', abort, { once: true })
  }
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, TEXT_MODEL_TIMEOUT_MS)
  let answer = ''
  let finished = false
  try {
    const events = streamChatCompletion(
      apiKey,
      {
        model: config.model,
        messages: [
          {
            role: 'system',
            content: [config.systemPrompt, TEXT_MODEL_INSTRUCTIONS].filter(Boolean).join('\n\n'),
          },
          { role: 'user', content: query },
        ],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: config.thinking ? 'enabled' : 'disabled' },
        ...(config.thinking && config.effort ? { reasoning_effort: config.effort } : {}),
        safety_check: { level: 'high' },
      },
      controller.signal
    )
    for await (const chunk of events) {
      for (const choice of chunk.choices) {
        if (choice.delta.content) {
          answer += choice.delta.content
        }
        if (choice.finish_reason) {
          finished = true
        }
      }
    }
    if (!answer.trim()) {
      return errorExecution('The text model returned an empty answer')
    }
    return { blocks: [], message: answer.trim() }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    if (error instanceof ApiError && error.kind === 'interrupted' && finished && answer.trim()) {
      // 与文字聊天一致：已经收到 finish_reason，仅缺末尾 [DONE] 时保留完整正文
      return { blocks: [], message: answer.trim() }
    }
    return errorExecution(timedOut ? 'The text model request timed out' : errorMessage(error))
  } finally {
    window.clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
