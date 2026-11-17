import type {
  ChatCompletionChunk,
  ChatContentPart,
  ChatMessageParam,
  ChatToolCall,
  ChatToolCallDelta,
  MessageUsage,
  OpenAIUsage,
  StopReason,
} from '../api/types.js'
import { toolCallsForHistory, toolMessageForHistory } from './tools.js'
import type { AssistantMessage, Message, ReplyBlock, ReplyStatus, UserMessage } from './types.js'

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/** 关闭末尾未结束的思考块 */
const closeThinking = (reply: AssistantMessage, now: number): AssistantMessage => {
  const last = reply.blocks.at(-1)
  if (last?.type !== 'thinking' || last.endedAt !== undefined) {
    return reply
  }
  return updateBlock(reply, reply.blocks.length - 1, (block) =>
    block.type === 'thinking' ? { ...block, endedAt: now } : block
  )
}

/** OpenAI finish_reason 映射到本地结束原因 */
const toStopReason = (finish: string): StopReason =>
  finish === 'length'
    ? 'max_tokens'
    : finish === 'content_filter'
      ? 'refusal'
      : finish === 'tool_calls'
        ? 'tool_use'
        : 'end_turn'

/** OpenAI usage 映射到本地用量形状，跨工具轮累加；prompt_tokens 含缓存命中，需扣除后计入 input_tokens */
const addUsage = (current: MessageUsage | undefined, usage: OpenAIUsage): MessageUsage => {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: (current?.input_tokens ?? 0) + Math.max(0, usage.prompt_tokens - cached),
    cache_creation_input_tokens: current?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: (current?.cache_read_input_tokens ?? 0) + cached,
    output_tokens: (current?.output_tokens ?? 0) + usage.completion_tokens,
  }
}

/**
 * 把一个流式 chunk 合并进回复：reasoning_content 开/续思考块，content 续文本块
 * （思考转正文时收尾思考块）；结束 chunk 更新结束原因；usage 独立 chunk 累加用量。
 * tool_calls 增量不进内容块，由 mergeToolCallDeltas 单独累积。
 */
export const applyChunk = (
  reply: AssistantMessage,
  chunk: ChatCompletionChunk,
  now: number
): AssistantMessage => {
  let next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  if (chunk.usage) {
    next = { ...next, usage: addUsage(next.usage, chunk.usage) }
  }
  const choice = chunk.choices[0]
  if (!choice) {
    return next
  }
  const { delta } = choice
  if (delta.reasoning_content) {
    const last = next.blocks.at(-1)
    if (last?.type === 'thinking' && last.endedAt === undefined) {
      const reasoning = delta.reasoning_content
      next = updateBlock(next, next.blocks.length - 1, (block) =>
        block.type === 'thinking' ? { ...block, thinking: block.thinking + reasoning } : block
      )
    } else {
      next = {
        ...next,
        blocks: [
          ...next.blocks,
          { type: 'thinking', thinking: delta.reasoning_content, startedAt: now },
        ],
      }
    }
  }
  if (delta.content) {
    next = closeThinking(next, now)
    const content = delta.content
    const last = next.blocks.at(-1)
    if (last?.type === 'text') {
      next = updateBlock(next, next.blocks.length - 1, (block) =>
        block.type === 'text' ? { ...block, text: block.text + content } : block
      )
    } else {
      next = { ...next, blocks: [...next.blocks, { type: 'text', text: content, citations: [] }] }
    }
  }
  if (choice.finish_reason) {
    next = closeThinking(next, now)
    next = { ...next, stopReason: toStopReason(choice.finish_reason) }
  }
  return next
}

/** 按 index 合并 tool_calls 增量：首片带 id/name，后续片仅 arguments 片段 */
export const mergeToolCallDeltas = (
  calls: Map<number, ChatToolCall>,
  deltas: ChatToolCallDelta[]
) => {
  deltas.forEach((delta, position) => {
    const index = delta.index ?? position
    const current = calls.get(index)
    const args = delta.function?.arguments ?? ''
    if (current) {
      calls.set(index, {
        ...current,
        id: delta.id ?? current.id,
        function: {
          name: delta.function?.name ?? current.function.name,
          arguments: current.function.arguments + args,
        },
      })
    } else {
      calls.set(index, {
        id: delta.id ?? '',
        type: 'function',
        function: { name: delta.function?.name ?? '', arguments: args },
        index,
      })
    }
  })
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（finish_reason: content_filter）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        block.type === 'mcp_tool_use' ||
        block.type === 'mcp_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' || (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 已结束或停止且有回答文本（或 MCP 生成媒体）的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  (getReplyText(message) !== '' ||
    message.blocks.some((block) => block.type === 'mcp_tool_result' && block.media.length > 0))

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/** 图片按本地原件内联 base64；没有原件的附件不进入请求。MCP 启用时附上图片引用 id 说明。 */
const toUserParam = (
  { content, files }: UserMessage,
  imageData: Map<string, string>,
  mcp = false
): ChatMessageParam | null => {
  const parts: ChatContentPart[] = files.flatMap((file) => {
    const url = file.isImage ? imageData.get(file.id) : undefined
    return url ? [{ type: 'image_url' as const, image_url: { url } }] : []
  })
  if (content) {
    parts.push({ type: 'text', text: content })
  }
  const imageFiles = mcp ? files.filter((file) => file.isImage) : []
  if (imageFiles.length > 0) {
    parts.push({
      type: 'text',
      text: `[MCP image references — pass these exact ids to image_ids / first_frame_id / last_frame_id when editing or animating the attached images: ${imageFiles
        .map((file) => `"${file.name}" = ${file.id}`)
        .join('; ')}]`,
    })
  }
  if (parts.length === 0) {
    return null
  }
  return { role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? content : parts }
}

/** 相邻文本直接拼接，被思考或工具隔开的文本用空行连接 */
const mergeText = (blocks: ReplyBlock[]): string => {
  let text = ''
  let gap = false
  for (const block of blocks) {
    if (block.type === 'text') {
      if (text && gap) {
        text += '\n\n'
      }
      text += block.text
      gap = false
    } else if (text) {
      gap = true
    }
  }
  return text
}

/**
 * 历史 assistant 轮：正文合并为字符串，工具轮合成 tool_calls 并紧随 tool 消息回传结果；
 * 历史思考不回传（OpenAI 兼容面无签名回传机制）。
 */
const toAssistantParams = (reply: AssistantMessage): ChatMessageParam[] => {
  const calls = toolCallsForHistory(reply.blocks)
  const text = mergeText(reply.blocks)
  const messages: ChatMessageParam[] = [
    {
      role: 'assistant',
      content: text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    },
  ]
  for (const call of calls) {
    const payload = toolMessageForHistory(reply.blocks, call.id)
    if (payload !== null) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: payload })
    }
  }
  return messages
}

/**
 * 把会话转成 OpenAI 兼容 messages：system 消息承载系统提示词与本轮环境快照
 * （latest_reminder 角色被网关拒绝，折进 system）；只保留「提问 + 有回答的回复」成对的轮次，
 * 最后接上本轮提问；续写时末尾再带上本轮 assistant 正文（网关接受末尾 assistant 前缀）。
 */
export const toOpenAIMessages = (
  history: Message[],
  question: UserMessage,
  systemText: string,
  imageData: Map<string, string>,
  prefix?: AssistantMessage,
  mcp = false
): ChatMessageParam[] => {
  const messages: ChatMessageParam[] = []
  if (systemText) {
    messages.push({ role: 'system', content: systemText })
  }
  for (const [user, reply] of getContextRounds(history)) {
    const userParam = toUserParam(user, imageData, mcp)
    // 历史提问没有文字、图片也没有本地原件时，提问为空，连同回答一起省略。
    if (userParam === null) {
      continue
    }
    messages.push(userParam, ...toAssistantParams(reply))
  }
  messages.push(
    toUserParam(question, imageData, mcp) ?? { role: 'user', content: question.content }
  )
  if (prefix?.prefix) {
    const text = mergeText(prefix.blocks)
    // 没有非空白正文时直接重发原问题，避免服务端拒绝空 Prefill。
    if (text.trim()) {
      messages.push({ role: 'assistant', content: text })
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
