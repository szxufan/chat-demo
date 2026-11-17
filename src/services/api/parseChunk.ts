import type { ChatCompletionChunk, ChatToolCallDelta, OpenAIUsage } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

const isUsage = (value: unknown): value is OpenAIUsage =>
  isRecord(value) &&
  Number.isFinite(value.prompt_tokens) &&
  Number.isFinite(value.completion_tokens) &&
  Number.isFinite(value.total_tokens)

/** 增量片段字段均可缺省；只校验出现字段类型 */
const isToolCallDelta = (value: unknown): value is ChatToolCallDelta =>
  isRecord(value) &&
  (value.index === undefined || isIndex(value.index)) &&
  (value.id === undefined || isString(value.id)) &&
  (value.function === undefined ||
    (isRecord(value.function) &&
      (value.function.name === undefined || isString(value.function.name)) &&
      (value.function.arguments === undefined || isString(value.function.arguments))))

const readChoice = (value: unknown): ChatCompletionChunk['choices'][number] | null => {
  if (!isRecord(value) || !isIndex(value.index) || !isRecord(value.delta)) {
    return null
  }
  const delta = value.delta
  const toolCalls = Array.isArray(delta.tool_calls)
    ? delta.tool_calls.filter(isToolCallDelta)
    : undefined
  return {
    index: value.index,
    delta: {
      ...(isString(delta.role) ? { role: delta.role } : {}),
      ...(isString(delta.content) ? { content: delta.content } : {}),
      ...(isString(delta.reasoning_content) ? { reasoning_content: delta.reasoning_content } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: isString(value.finish_reason) ? value.finish_reason : null,
  }
}

/** 未识别或无法安全消费的 chunk 静默丢弃；usage 独立 chunk（choices 为空）保留 */
export const readChunk = (value: unknown): ChatCompletionChunk | null => {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return null
  }
  const choices = value.choices
    .map(readChoice)
    .filter((choice): choice is ChatCompletionChunk['choices'][number] => choice !== null)
  const usage = isUsage(value.usage) ? value.usage : undefined
  if (choices.length === 0 && usage === undefined) {
    return null
  }
  return {
    id: isString(value.id) ? value.id : '',
    choices,
    ...(usage ? { usage } : {}),
  }
}
