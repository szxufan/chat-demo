import type { ModelInfo } from '../api/types.js'
import { getReplyText } from './reply.js'
import { toolCallsForHistory, toolMessageForHistory } from './tools.js'
import type { AssistantMessage, UserMessage } from './types.js'

/** 进入请求上下文的一轮：提问 + 可用回答 */
export type ContextRound = [UserMessage, AssistantMessage]

/** 每条消息的固定开销（role、分隔符等） */
export const MESSAGE_OVERHEAD = 4
/** 图片按固定值估算；base64 长度不能计入文本 */
const IMAGE_TOKEN_ESTIMATE = 1200
/** 裁剪时保留的最近轮数 */
export const KEEP_ROUNDS = 4
/** max_output_tokens 缺省时的输出预留 */
const OUTPUT_RESERVE_DEFAULT = 4096
/** 预算安全系数：吸收估算误差与摘要增长 */
const BUDGET_RATIO = 0.9
/** 压缩序列化时每轮正文的字符上限 */
const SUMMARY_ROUND_CHAR_CAP = 4000
/** 单次压缩调用的输入 token 上限，超过则分块滚动摘要 */
const SUMMARY_CHUNK_TOKENS = 16000

/** CJK（含日文假名、谚文、全角符号）约 1 token/字 */
const isCjkCode = (code: number): boolean =>
  (code >= 0x3000 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xff00 && code <= 0xffef)

/** 无 tokenizer 的启发式估算：CJK 约 1 token/字，其余约 3.5 字符/token */
export const estimateTextTokens = (text: string): number => {
  let cjk = 0
  for (const char of text) {
    if (isCjkCode(char.codePointAt(0) ?? 0)) {
      cjk += 1
    }
  }
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

/** 提问的开销：正文 + 图片（没有原件的图片实际不进请求，估算从多） */
export const estimateUserTokens = (user: UserMessage): number =>
  estimateTextTokens(user.content) +
  MESSAGE_OVERHEAD +
  user.files.filter((file) => file.isImage).length * IMAGE_TOKEN_ESTIMATE

/** 一轮历史的请求开销：提问（含图片）+ 回答正文 + 工具调用与结果 */
export const estimateRoundTokens = ([user, reply]: ContextRound): number => {
  let tokens = estimateUserTokens(user) + estimateTextTokens(getReplyText(reply)) + MESSAGE_OVERHEAD
  for (const call of toolCallsForHistory(reply.blocks)) {
    tokens += estimateTextTokens(call.function.arguments) + MESSAGE_OVERHEAD
    const payload = toolMessageForHistory(reply.blocks, call.id)
    if (payload !== null) {
      tokens += estimateTextTokens(payload) + MESSAGE_OVERHEAD
    }
  }
  return tokens
}

/** 请求预算：上下文窗口减输出预留再乘安全系数；窗口未知返回 null（跳过主动裁剪） */
export const contextBudget = (info: ModelInfo | undefined): number | null => {
  if (!info?.context_length) {
    return null
  }
  const reserve = Math.min(
    info.max_output_tokens ?? OUTPUT_RESERVE_DEFAULT,
    Math.floor(info.context_length / 2)
  )
  return Math.floor((info.context_length - reserve) * BUDGET_RATIO)
}

/**
 * 按摘要锚点解析请求窗口：锚点之后的轮次进入请求。
 * 锚点不在轮次中（切换分支、编辑早期消息）时摘要失效，回退全量历史。
 * anchorIndex 为锚点轮次的下标，-1 表示没有有效摘要。
 */
export const resolveWindow = (
  rounds: ContextRound[],
  anchorMessageId: string | undefined
): { window: ContextRound[]; anchorIndex: number } => {
  const anchorIndex = anchorMessageId
    ? rounds.findIndex(([, reply]) => reply.id === anchorMessageId)
    : -1
  return anchorIndex < 0
    ? { window: rounds, anchorIndex: -1 }
    : { window: rounds.slice(anchorIndex + 1), anchorIndex }
}

/**
 * 裁剪边界：保留最近 KEEP_ROUNDS 轮，仍超预算则从最旧继续丢弃，最少保 1 轮。
 * 边界不低于 coveredCount，已压缩的轮次不会重新以原文进入请求。
 * 返回保留的首轮下标，其前的轮次为压缩候选。
 */
export const planTrimBoundary = (
  rounds: ContextRound[],
  coveredCount: number,
  fixedTokens: number,
  budget: number
): number => {
  let boundary = Math.max(coveredCount, rounds.length - KEEP_ROUNDS)
  let keptTokens = rounds
    .slice(boundary)
    .reduce((sum, round) => sum + estimateRoundTokens(round), 0)
  while (boundary < rounds.length - 1 && fixedTokens + keptTokens > budget) {
    keptTokens -= estimateRoundTokens(rounds[boundary])
    boundary += 1
  }
  return boundary
}

/** 压缩输入序列化：只取提问与回答正文，每轮截断控制开销 */
export const serializeRoundsForSummary = (rounds: ContextRound[]): string =>
  rounds
    .map(([user, reply]) => {
      const question = user.content.slice(0, SUMMARY_ROUND_CHAR_CAP)
      const answer = getReplyText(reply).slice(0, SUMMARY_ROUND_CHAR_CAP)
      return `User: ${question}\nAssistant: ${answer}`
    })
    .join('\n\n')

/** 按 token 上限给压缩输入分块；单轮超限也独立成块，滚动摘要 */
export const chunkRoundsForSummary = (rounds: ContextRound[]): ContextRound[][] => {
  const chunks: ContextRound[][] = []
  let current: ContextRound[] = []
  let tokens = 0
  for (const round of rounds) {
    const cost = estimateTextTokens(serializeRoundsForSummary([round]))
    if (current.length > 0 && tokens + cost > SUMMARY_CHUNK_TOKENS) {
      chunks.push(current)
      current = []
      tokens = 0
    }
    current.push(round)
    tokens += cost
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}
