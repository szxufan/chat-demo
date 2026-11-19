import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { API_ORIGIN } from '../api/client.js'
import type { ChatToolCall } from '../api/types.js'
import { getReplyText } from '../chat/reply.js'
import { executeToolCall, type McpExecution, type ToolExecution } from '../chat/tools.js'
import {
  appendRealtimeReply,
  appendRealtimeUserMessage,
  beginRealtimeSession,
  endRealtimeSession,
  finishRealtimeReply,
  patchRealtimeReply,
  persistRealtimeSession,
  requestRealtimeTitle,
  useChatStore,
} from '../chat/store.js'
import type { AssistantMessage } from '../chat/types.js'
import { getMcpToolset, type McpToolset } from '../mcp/tools.js'
import { useModels } from '../models.js'
import { setRealtimeModel, setRealtimeVoice, useSettings } from '../settings.js'
import { base64ToBytes, bytesToBase64 } from './pcm.js'
import { PcmPlayer } from './pcmPlayer.js'
import { stopReadAloud } from './readAloud.js'
import { startStreamingRecording, type StreamingRecording } from './recorder.js'
import { isQwen38OmniModel, resolveRealtimeVoice } from './realtimeVoices.js'

/**
 * 实时语音通话（百炼 Realtime，经网关 /v1/realtime 中继）。
 * 浏览器 WebSocket 无法发送 Authorization 头，鉴权走子协议 openai-insecure-api-key.<key>。
 * 输入 16kHz pcm16 按 100ms 分帧上行；输出 24kHz pcm16 base64 增量边收边播；
 * server VAD 自动断句，用户开口即打断 AI 播放；转写按普通消息落会话。
 */

/** 实时输出音频采样率：24kHz 单声道 16-bit 小端 */
const OUTPUT_SAMPLE_RATE = 24000
/** 输入转写模型（百炼 realtime ASR）；按网关模型可调整为 qwen3-asr-flash-realtime */
const TRANSCRIPTION_MODEL = 'gummy-realtime-v1'
/** 与文字聊天一致；达限后正常回传末轮结果，再让模型基于已有结果收尾 */
const MCP_TOOL_ROUND_LIMIT = 80
/** 达限收尾指令与文字聊天一致；Realtime 通过临时 session.update 撤销工具声明 */
const TOOL_WRAP_UP_PROMPT =
  'The tool-call round limit has been reached; no more tool calls are allowed. Use the tool results above to give your final answer directly. If they are insufficient, answer with what you have and briefly note what is missing.'
/** 当前官方 Function Calling 文档明确覆盖 Qwen3.5 / Qwen3.8 Omni Realtime */
const FUNCTION_CALLING_MODEL = /qwen3\.(?:5|8)-omni/i

/** 麦克风依赖 getUserMedia，只在安全上下文可用（与语音输入一致） */
export const REALTIME_AVAILABLE = typeof window === 'undefined' || window.isSecureContext

export type RealtimeStatus = 'idle' | 'connecting' | 'active'

type RealtimeState = {
  status: RealtimeStatus
  /** 通话绑定的聊天会话 */
  chatSessionId: string | null
  model: string | null
  voice: string
  muted: boolean
  /** 浏览器正在执行 MCP 工具，等待结果回填模型 */
  toolRunning: boolean
  /** 当前说话方：user 用户说话 / assistant AI 回复；null 静默 */
  speaking: 'user' | 'assistant' | null
  /** 用户实时部分转写（定稿后进消息列表） */
  userText: string
}

export const useRealtime = create<RealtimeState>(() => ({
  status: 'idle',
  chatSessionId: null,
  model: null,
  voice: useSettings.getState().realtimeVoice,
  muted: false,
  toolRunning: false,
  speaking: null,
  userText: '',
}))

type PendingFunctionCall = {
  id: string
  responseId: string
  name: string
  arguments: string
  index: number
}

type Call = {
  sessionId: string
  apiKey: string
  controller: AbortController
  socket: WebSocket
  player: PcmPlayer
  recording: StreamingRecording | null
  activating: boolean
  model: string
  mcpRequested: boolean
  mcpToolset: McpToolset | null
  sessionInitialized: boolean
  sessionReady: boolean
  /** 当前用户语音逻辑轮次；可跨多个工具 Response 复用 */
  reply: AssistantMessage | null
  /** 是否有进行中的 response（打断判断） */
  responding: boolean
  /** 本地已因用户开口取消；即使服务端迟到 done=completed 也不能执行其工具 */
  cancellingResponse: boolean
  responseId: string | null
  pendingCalls: Map<string, PendingFunctionCall>
  continuationExpected: boolean
  /** 达限收尾需先等 tools=[] 的 session.updated，再允许续答 */
  continuationPendingUpdate: boolean
  /** 工具结果已发送但被用户打断时，丢弃随后到达的旧续答 */
  discardNextResponse: boolean
  discardingResponse: boolean
  toolBatch: number
  toolBatchController: AbortController | null
  toolRounds: number
  /** 达限后的最终续答：临时撤销工具，结束后恢复 */
  wrappingUp: boolean
  /** 首条用户转写，用于自动补标题；触发后置 null */
  firstQuestion: string | null
  /** 当前用户轮次的部分转写 */
  userDraft: string
  /** 转写失败只提示一次 */
  transcribeFailedShown: boolean
  ended: boolean
  frame: number
}

let current: Call | null = null

type FunctionCallPayload = {
  response_id?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
  output_index?: unknown
}

/** 服务端事件：只声明用到的字段，其余宽容忽略 */
type ServerEvent = FunctionCallPayload & {
  type?: string
  delta?: unknown
  transcript?: unknown
  text?: unknown
  stash?: unknown
  error?: { message?: unknown; code?: unknown }
  response?: { id?: unknown; status?: unknown; output?: unknown }
}

const readString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const send = (call: Call, payload: Record<string, unknown>) => {
  if (!call.ended && call.socket.readyState === WebSocket.OPEN) {
    call.socket.send(JSON.stringify(payload))
  }
}

/** 会话配置：系统提示词取会话覆盖或全局设置；Qwen3.8 与旧模型使用各自的音色字段。 */
const sessionConfig = (call: Call) => {
  const chat = useChatStore.getState().sessionCache[call.sessionId]
  const baseInstructions = chat?.systemPrompt ?? useSettings.getState().systemPrompt
  const instructions = call.wrappingUp
    ? `${baseInstructions}\n\n${TOOL_WRAP_UP_PROMPT}`
    : baseInstructions
  const voice = useRealtime.getState().voice
  const voiceConfig = isQwen38OmniModel(call.model) ? { audio: { output: { voice } } } : { voice }
  return {
    modalities: ['text', 'audio'],
    instructions,
    ...voiceConfig,
    ...(call.wrappingUp
      ? { tools: [] }
      : call.mcpToolset?.tools.length
        ? { tools: call.mcpToolset.tools }
        : {}),
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    input_audio_transcription: { model: TRANSCRIPTION_MODEL },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 500,
      silence_duration_ms: 600,
    },
  }
}

/** 合并尚未绘制的回复增量（与 streamReply 的 rAF 批量一致） */
const flushReply = (call: Call) => {
  cancelAnimationFrame(call.frame)
  call.frame = 0
  const reply = call.reply
  if (reply) {
    patchRealtimeReply(call.sessionId, reply.id, () => reply)
  }
}

const appendReplyText = (call: Call, delta: string) => {
  const reply = call.reply
  if (!reply) {
    return
  }
  const blocks = [...reply.blocks]
  const last = blocks.at(-1)
  if (last?.type === 'text') {
    blocks[blocks.length - 1] = { ...last, text: last.text + delta }
  } else {
    blocks.push({ type: 'text', text: delta })
  }
  call.reply = { ...reply, blocks }
  if (document.visibilityState === 'hidden') {
    flushReply(call)
  } else {
    call.frame ||= requestAnimationFrame(() => flushReply(call))
  }
}

/** 工具回调与文本增量共用同一份可变回复，避免整体 flush 覆盖工具块 */
const updateCurrentReply = (call: Call, update: (reply: AssistantMessage) => AssistantMessage) => {
  const reply = call.reply
  if (reply) {
    call.reply = update(reply)
    flushReply(call)
  }
}

/** 使旧工具批次失效；Abort 只取消当前批次，不结束整通电话 */
const invalidateToolBatch = (call: Call) => {
  call.toolBatch += 1
  call.toolBatchController?.abort()
  call.toolBatchController = null
  call.pendingCalls.clear()
  if (current === call) {
    useRealtime.setState({ toolRunning: false })
  }
}

/** 一个用户语音轮次收尾：工具中间 Response 不调用这里 */
const finishResponse = (call: Call, status: 'done' | 'stopped') => {
  const restoreTools = call.wrappingUp
  call.wrappingUp = false
  invalidateToolBatch(call)
  flushReply(call)
  const reply = call.reply
  call.reply = null
  call.responding = false
  call.cancellingResponse = false
  call.responseId = null
  call.continuationExpected = false
  call.continuationPendingUpdate = false
  call.discardingResponse = false
  useRealtime.setState({ speaking: null, toolRunning: false })
  if (restoreTools && current === call && !call.ended && call.sessionReady) {
    send(call, { type: 'session.update', session: sessionConfig(call) })
  }
  if (!reply) {
    return
  }
  finishRealtimeReply(call.sessionId, reply.id, status)
  if (status === 'done' && call.firstQuestion !== null) {
    const question = call.firstQuestion
    call.firstQuestion = null
    const answer = getReplyText(reply)
    if (answer.trim()) {
      requestRealtimeTitle(call.sessionId, question, answer)
    }
  }
}

/** done 事件已带完整参数；response.done.output 仅用于补齐漏收事件并按 call_id 去重 */
const collectFunctionCall = (
  call: Call,
  value: FunctionCallPayload,
  responseIdFallback?: string
) => {
  if (!call.responding || call.cancellingResponse || call.discardingResponse || !call.mcpToolset) {
    return
  }
  const id = readString(value.call_id)
  const name = readString(value.name)
  const args = readString(value.arguments)
  const responseId = readString(value.response_id) ?? responseIdFallback ?? call.responseId ?? ''
  if (!id || !name || args === null || (call.responseId && responseId !== call.responseId)) {
    return
  }
  call.pendingCalls.set(id, {
    id,
    responseId,
    name,
    arguments: args,
    index: typeof value.output_index === 'number' ? value.output_index : call.pendingCalls.size,
  })
}

/** 未声明的工具必须显式失败，不能交给 executeToolCall 落入联网搜索分支 */
const unknownToolExecution = (pending: PendingFunctionCall): ToolExecution => {
  let input: unknown = {}
  try {
    input = JSON.parse(pending.arguments)
  } catch {
    // 与 MCP 执行器一致，非法参数以空对象展示；错误通过结果回传模型
  }
  const message = JSON.stringify({ error: `Unknown MCP tool: ${pending.name}` })
  const now = Date.now()
  return {
    blocks: [
      {
        type: 'mcp_tool_use',
        id: pending.id,
        name: pending.name,
        input,
        startedAt: now,
      },
      {
        type: 'mcp_tool_result',
        tool_use_id: pending.id,
        message,
        media: [],
        isError: true,
        endedAt: now,
      },
    ],
    message,
  }
}

/** 一个 Response 的全部工具作为一批执行；全部回填后只创建一次续答 */
const runToolBatch = async (call: Call, calls: PendingFunctionCall[], wrapUp = false) => {
  const toolset = call.mcpToolset
  const reply = call.reply
  if (!toolset || !reply) {
    finishResponse(call, 'stopped')
    return
  }
  const batch = ++call.toolBatch
  const replyId = reply.id
  const controller = new AbortController()
  call.toolBatchController = controller
  call.responding = false
  useRealtime.setState({ speaking: null, toolRunning: true })
  const isActive = () =>
    current === call &&
    !call.ended &&
    call.toolBatch === batch &&
    !controller.signal.aborted &&
    call.reply?.id === replyId
  const mcpExecution: McpExecution = {
    route: toolset.route,
    onCallBlock: (block) => {
      if (isActive()) {
        updateCurrentReply(call, (currentReply) => ({
          ...currentReply,
          blocks: [...currentReply.blocks, block],
        }))
      }
    },
    onProgress: (toolUseId, progress) => {
      if (isActive()) {
        updateCurrentReply(call, (currentReply) => ({
          ...currentReply,
          blocks: currentReply.blocks.map((block) =>
            block.type === 'mcp_tool_use' && block.id === toolUseId ? { ...block, progress } : block
          ),
        }))
      }
    },
  }
  try {
    const executions = await Promise.all(
      calls.map(async (pending) => {
        if (!toolset.route.has(pending.name)) {
          return unknownToolExecution(pending)
        }
        const toolCall: ChatToolCall = {
          id: pending.id,
          type: 'function',
          function: { name: pending.name, arguments: pending.arguments },
          index: pending.index,
        }
        return executeToolCall(call.apiKey, toolCall, controller.signal, mcpExecution)
      })
    )
    if (!isActive()) {
      return
    }
    updateCurrentReply(call, (currentReply) => ({
      ...currentReply,
      blocks: [...currentReply.blocks, ...executions.flatMap((execution) => execution.blocks)],
    }))
    if (call.socket.readyState !== WebSocket.OPEN) {
      finishResponse(call, 'stopped')
      return
    }
    executions.forEach((execution, index) => {
      send(call, {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: calls[index].id,
          output: execution.message || '{}',
        },
      })
    })
    call.continuationExpected = true
    if (wrapUp) {
      call.wrappingUp = true
      call.continuationPendingUpdate = true
      send(call, { type: 'session.update', session: sessionConfig(call) })
    }
    useRealtime.setState({ toolRunning: false })
    if (!wrapUp) {
      send(call, { type: 'response.create', response: { modalities: ['text', 'audio'] } })
    }
  } catch {
    if (isActive()) {
      showToast({ key: 'mcpToolFailed' })
      finishResponse(call, 'stopped')
    }
  } finally {
    if (call.toolBatch === batch) {
      call.toolBatchController = null
    }
  }
}

const describeMicError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'realtimeMicFailed' }
}

/** 服务端 error 事件分类；无法识别时展示服务端原文 */
const describeServerError = (error: ServerEvent['error']): TranslationMessage | string => {
  const code = readString(error?.code) ?? ''
  const message = readString(error?.message) ?? ''
  const text = `${code} ${message}`.toLowerCase()
  if (text.includes('unauthorized') || text.includes('invalid api') || text.includes('401')) {
    return { key: 'apiKeyInvalidRetry' }
  }
  if (text.includes('arrearage') || text.includes('balance')) {
    return { key: 'insufficientBalance' }
  }
  if (text.includes('throttling') || text.includes('rate limit') || text.includes('429')) {
    return { key: 'rateLimited' }
  }
  return message ? { key: 'realtimeFailedDetail', params: { message } } : { key: 'realtimeFailed' }
}

/** 异常断开的提示；握手失败浏览器拿不到 HTTP 状态，统一提示检查 Key 与网关配置 */
const describeClose = (event: CloseEvent): TranslationMessage => {
  if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
    return { key: 'apiKeyInvalidRetry' }
  }
  if (useRealtime.getState().status !== 'active') {
    return { key: 'realtimeConnectFailed' }
  }
  if (event.code === 1000) {
    // 服务端正常关闭（如 120 分钟会话上限）
    return { key: 'realtimeEnded' }
  }
  return { key: 'realtimeDisconnected' }
}

const failCall = (call: Call, message: TranslationMessage | string) => {
  if (call.ended || current !== call) {
    return
  }
  endRealtimeCall()
  showToast(message)
}

/** 首次配置必须等工具发现结束；失败降级为无工具通话，不让用户首句抢跑 */
const initializeSession = async (call: Call) => {
  if (call.sessionInitialized) {
    return
  }
  call.sessionInitialized = true
  if (call.mcpRequested) {
    try {
      const toolset = await getMcpToolset(call.apiKey, call.controller.signal)
      if (call.ended || current !== call) {
        return
      }
      if (toolset.tools.length > 0) {
        call.mcpToolset = toolset
      }
    } catch {
      if (call.ended || current !== call || call.controller.signal.aborted) {
        return
      }
      showToast({ key: 'realtimeMcpUnavailable' })
    }
  }
  if (call.ended || current !== call) {
    return
  }
  call.sessionReady = true
  send(call, { type: 'session.update', session: sessionConfig(call) })
}

/** session.updated 后启动麦克风；授权失败或迟到结果都正确收尾 */
const activate = async (call: Call) => {
  if (call.ended || current !== call || call.recording || call.activating) {
    return
  }
  call.activating = true
  try {
    const recording = await startStreamingRecording((frame) => {
      if (call.ended || current !== call || useRealtime.getState().muted) {
        return
      }
      send(call, { type: 'input_audio_buffer.append', audio: bytesToBase64(frame) })
    })
    if (call.ended || current !== call) {
      recording.stop()
      return
    }
    call.recording = recording
    useRealtime.setState({ status: 'active' })
  } catch (error) {
    failCall(call, describeMicError(error))
  } finally {
    call.activating = false
  }
}

const handleMessage = (call: Call, raw: MessageEvent) => {
  if (call.ended || current !== call) {
    return
  }
  let event: ServerEvent
  try {
    event = JSON.parse(String(raw.data)) as ServerEvent
  } catch {
    return
  }
  switch (event.type) {
    case 'session.created':
      void initializeSession(call)
      break
    case 'session.updated':
      if (call.continuationPendingUpdate && call.wrappingUp && call.continuationExpected) {
        call.continuationPendingUpdate = false
        send(call, { type: 'response.create', response: { modalities: ['text', 'audio'] } })
      }
      void activate(call)
      break
    case 'input_audio_buffer.speech_started': {
      // 工具执行或等待续答时没有活动 Response 可取消，本地批次必须立即失效
      const runningTools = call.toolBatchController !== null
      const waitingContinuation = call.continuationExpected
      invalidateToolBatch(call)
      if (waitingContinuation) {
        call.discardNextResponse = true
      }
      if ((runningTools || waitingContinuation) && call.reply) {
        finishResponse(call, 'stopped')
      }
      if (call.responding) {
        call.cancellingResponse = true
        send(call, { type: 'response.cancel' })
      }
      call.player.flush()
      useRealtime.setState({ speaking: 'user', toolRunning: false })
      break
    }
    case 'input_audio_buffer.speech_stopped':
      useRealtime.setState({ speaking: null })
      break
    case 'conversation.item.input_audio_transcription.delta': {
      // 百炼：text 为已确认前缀，stash 为待确认后缀；兼容 OpenAI 式 delta
      const text = readString(event.text) ?? readString(event.delta) ?? ''
      const stash = readString(event.stash) ?? ''
      call.userDraft = text + stash
      useRealtime.setState({ userText: call.userDraft })
      break
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = (readString(event.transcript) ?? call.userDraft).trim()
      call.userDraft = ''
      useRealtime.setState({ userText: '' })
      if (transcript) {
        appendRealtimeUserMessage(call.sessionId, transcript)
        if (call.firstQuestion === null) {
          call.firstQuestion = transcript
        }
      }
      break
    }
    case 'conversation.item.input_audio_transcription.failed':
      if (!call.transcribeFailedShown) {
        call.transcribeFailedShown = true
        showToast({ key: 'realtimeTranscribeFailed' })
      }
      break
    case 'response.created': {
      const responseId = readString(event.response?.id)
      if (call.discardNextResponse) {
        call.discardNextResponse = false
        call.discardingResponse = true
        call.responseId = responseId
        call.responding = true
        send(call, { type: 'response.cancel' })
        break
      }
      if (call.discardingResponse) {
        if (responseId && call.responseId && responseId !== call.responseId) {
          call.discardingResponse = false
        } else {
          break
        }
      }
      const continuing = call.continuationExpected && call.reply !== null
      if (call.reply && !continuing) {
        finishResponse(call, 'stopped')
      }
      if (!call.reply) {
        call.reply = appendRealtimeReply(call.sessionId, call.model, call.mcpToolset !== null)
        call.toolRounds = 0
      }
      call.responseId = responseId
      call.pendingCalls.clear()
      call.continuationExpected = false
      call.responding = true
      call.cancellingResponse = false
      useRealtime.setState({ speaking: 'assistant', toolRunning: false })
      updateCurrentReply(call, (reply) => ({ ...reply, status: 'streaming' }))
      break
    }
    case 'response.function_call_arguments.done':
      collectFunctionCall(call, event)
      break
    case 'response.audio_transcript.delta': {
      const responseId = readString(event.response_id)
      if (
        call.discardingResponse ||
        (call.responseId && responseId && call.responseId !== responseId)
      ) {
        break
      }
      const delta = readString(event.delta)
      if (delta) {
        appendReplyText(call, delta)
      }
      break
    }
    case 'response.audio.delta': {
      const responseId = readString(event.response_id)
      if (
        call.discardingResponse ||
        (call.responseId && responseId && call.responseId !== responseId)
      ) {
        break
      }
      const delta = readString(event.delta)
      if (delta) {
        call.player.push(base64ToBytes(delta))
      }
      break
    }
    case 'response.done': {
      const responseId = readString(event.response?.id)
      if (call.discardingResponse) {
        if (!responseId || !call.responseId || responseId === call.responseId) {
          call.discardingResponse = false
          call.responding = false
          call.responseId = null
        }
        break
      }
      if (call.responseId && responseId && call.responseId !== responseId) {
        break
      }
      if (call.cancellingResponse) {
        finishResponse(call, 'stopped')
        break
      }
      if (Array.isArray(event.response?.output)) {
        for (const item of event.response.output) {
          if (isRecord(item) && item.type === 'function_call') {
            collectFunctionCall(call, item, responseId ?? undefined)
          }
        }
      }
      const calls = [...call.pendingCalls.values()].sort((a, b) => a.index - b.index)
      call.pendingCalls.clear()
      const status = readString(event.response?.status)
      if (status === 'cancelled' || status === 'failed' || status === 'incomplete') {
        finishResponse(call, 'stopped')
        break
      }
      if (call.wrappingUp) {
        finishResponse(call, 'done')
        break
      }
      if (calls.length > 0 && call.mcpToolset) {
        const wrapUp = call.toolRounds + 1 >= MCP_TOOL_ROUND_LIMIT
        call.toolRounds += 1
        void runToolBatch(call, calls, wrapUp)
        break
      }
      finishResponse(call, 'done')
      break
    }
    case 'error':
      failCall(call, describeServerError(event.error))
      break
    default:
      // 其余事件（output_item/content_part 等）不影响转写、工具调用与播放，忽略
      break
  }
}

/**
 * 开始实时语音通话；必须在点击手势内同步调用（播放 AudioContext 需要用户手势）。
 * 条件不满足（无 Key / 无 realtime 模型 / 已有通话 / 导入中）返回 false。
 */
export const startRealtimeCall = (targetSessionId: string | null): boolean => {
  if (current || !REALTIME_AVAILABLE) {
    return false
  }
  const { apiKey, realtimeModel, realtimeVoice, mcp } = useSettings.getState()
  const model = realtimeModel ?? useModels.getState().realtimeModels[0]?.id
  if (!apiKey || !model) {
    return false
  }
  const voice = resolveRealtimeVoice(model, realtimeVoice)
  if (voice !== realtimeVoice) {
    setRealtimeVoice(voice)
  }
  const begun = beginRealtimeSession(targetSessionId)
  if (!begun) {
    return false
  }
  const { sessionId, controller } = begun
  stopReadAloud()
  const url = `${API_ORIGIN.replace(/^http/, 'ws')}/v1/realtime?model=${encodeURIComponent(model)}`
  let player: PcmPlayer
  let socket: WebSocket
  try {
    // 播放上下文在手势内同步创建；麦克风授权随后异步进行
    player = new PcmPlayer(new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }), OUTPUT_SAMPLE_RATE)
    socket = new WebSocket(url, ['realtime', `openai-insecure-api-key.${apiKey}`])
  } catch {
    endRealtimeSession(sessionId)
    showToast({ key: 'realtimeConnectFailed' })
    return false
  }
  const call: Call = {
    sessionId,
    apiKey,
    controller,
    socket,
    player,
    recording: null,
    activating: false,
    model,
    mcpRequested: mcp && FUNCTION_CALLING_MODEL.test(model),
    mcpToolset: null,
    sessionInitialized: false,
    sessionReady: false,
    reply: null,
    responding: false,
    cancellingResponse: false,
    responseId: null,
    pendingCalls: new Map(),
    continuationExpected: false,
    continuationPendingUpdate: false,
    discardNextResponse: false,
    discardingResponse: false,
    toolBatch: 0,
    toolBatchController: null,
    toolRounds: 0,
    wrappingUp: false,
    firstQuestion: null,
    userDraft: '',
    transcribeFailedShown: false,
    ended: false,
    frame: 0,
  }
  current = call
  useRealtime.setState({
    status: 'connecting',
    chatSessionId: sessionId,
    model,
    voice,
    muted: false,
    toolRunning: false,
    speaking: null,
    userText: '',
  })
  // 停止按钮/删除会话经 streaming 控制器中止通话
  controller.signal.addEventListener('abort', () => {
    if (current === call) {
      endRealtimeCall()
    }
  })
  socket.onmessage = (event) => handleMessage(call, event)
  socket.onclose = (event) => {
    if (call.ended || current !== call) {
      return
    }
    failCall(call, describeClose(event))
  }
  return true
}

/** 结束通话：释放麦克风与播放、关闭连接，进行中的回复按已停止收尾 */
export const endRealtimeCall = () => {
  const call = current
  if (!call || call.ended) {
    return
  }
  call.ended = true
  current = null
  invalidateToolBatch(call)
  call.controller.abort()
  call.continuationExpected = false
  call.continuationPendingUpdate = false
  call.discardNextResponse = false
  call.discardingResponse = false
  call.cancellingResponse = false
  call.wrappingUp = false
  call.responseId = null
  call.recording?.stop()
  call.player.dispose()
  flushReply(call)
  const reply = call.reply
  call.reply = null
  call.responding = false
  if (reply) {
    finishRealtimeReply(call.sessionId, reply.id, 'stopped')
  }
  endRealtimeSession(call.sessionId)
  useRealtime.setState({
    status: 'idle',
    chatSessionId: null,
    model: null,
    speaking: null,
    toolRunning: false,
    userText: '',
    muted: false,
  })
  try {
    call.socket.close(1000)
  } catch {
    // 连接可能已关闭
  }
}

/** 静音切换：静音期间不上行音频，服务端 VAD 不会触发 */
export const toggleRealtimeMute = () => {
  useRealtime.setState({ muted: !useRealtime.getState().muted })
}

/** 切换音色：持久化并通知服务端，下一轮回复生效 */
export const changeRealtimeVoice = (voice: string) => {
  setRealtimeVoice(voice)
  useRealtime.setState({ voice })
  const call = current
  if (call && !call.ended && call.sessionReady) {
    send(call, { type: 'session.update', session: sessionConfig(call) })
  }
}

/** 切换实时模型：校正音色并以新模型重连（已落会话的转写保留，服务端上下文重置） */
export const changeRealtimeModel = (model: string) => {
  setRealtimeModel(model)
  const { realtimeVoice } = useSettings.getState()
  const voice = resolveRealtimeVoice(model, realtimeVoice)
  if (voice !== realtimeVoice) {
    setRealtimeVoice(voice)
    useRealtime.setState({ voice })
  }
  const call = current
  if (!call || call.ended) {
    return
  }
  const { sessionId } = call
  endRealtimeCall()
  startRealtimeCall(sessionId)
}

/** 当前通话的频谱分析节点，未通话时为 null */
export const getRealtimeAnalyser = (): AnalyserNode | null => current?.recording?.analyser ?? null

/** 应用启动时挂载：切换会话/导入历史结束通话；页面隐藏或关闭前落盘未绘制的增量 */
export const bindRealtime = () => {
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    const call = current
    if (!call) {
      return
    }
    if (state.importingHistory && !previous.importingHistory) {
      endRealtimeCall()
      return
    }
    if (state.activeId !== previous.activeId && state.activeId !== call.sessionId) {
      endRealtimeCall()
    }
  })
  const save = () => {
    const call = current
    if (call && !call.ended) {
      flushReply(call)
      persistRealtimeSession(call.sessionId)
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}
