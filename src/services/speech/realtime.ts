import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { API_ORIGIN } from '../api/client.js'
import { getReplyText } from '../chat/reply.js'
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
import { useModels } from '../models.js'
import { setRealtimeModel, setRealtimeVoice, useSettings } from '../settings.js'
import { base64ToBytes, bytesToBase64 } from './pcm.js'
import { PcmPlayer } from './pcmPlayer.js'
import { stopReadAloud } from './readAloud.js'
import { startStreamingRecording, type StreamingRecording } from './recorder.js'

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

/** 百炼 realtime 常用音色；实际可用集合随模型而定 */
export const REALTIME_VOICES = [
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Jada',
  'Dylan',
  'Sunny',
] as const

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
  speaking: null,
  userText: '',
}))

type Call = {
  sessionId: string
  controller: AbortController
  socket: WebSocket
  player: PcmPlayer
  recording: StreamingRecording | null
  model: string
  /** 正在生成的回复；轮次结束置 null */
  reply: AssistantMessage | null
  /** 是否有进行中的 response（打断判断） */
  responding: boolean
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

/** 服务端事件：只声明用到的字段，其余宽容忽略 */
type ServerEvent = {
  type?: string
  delta?: unknown
  transcript?: unknown
  text?: unknown
  stash?: unknown
  error?: { message?: unknown; code?: unknown }
  response?: { status?: unknown }
}

const readString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const send = (call: Call, payload: Record<string, unknown>) => {
  if (!call.ended && call.socket.readyState === WebSocket.OPEN) {
    call.socket.send(JSON.stringify(payload))
  }
}

/** 会话配置：系统提示词取会话覆盖或全局设置；音色取当前选择 */
const sessionConfig = (call: Call) => {
  const chat = useChatStore.getState().sessionCache[call.sessionId]
  const instructions = chat?.systemPrompt ?? useSettings.getState().systemPrompt
  return {
    modalities: ['text', 'audio'],
    instructions,
    voice: useRealtime.getState().voice,
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

/** 一轮回复收尾：落盘并按需补标题 */
const finishResponse = (call: Call, status: 'done' | 'stopped') => {
  flushReply(call)
  const reply = call.reply
  call.reply = null
  call.responding = false
  useRealtime.setState({ speaking: null })
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

/** session.updated 后启动麦克风；授权失败或迟到结果都正确收尾 */
const activate = async (call: Call) => {
  if (call.ended || current !== call || call.recording) {
    return
  }
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
      send(call, { type: 'session.update', session: sessionConfig(call) })
      break
    case 'session.updated':
      void activate(call)
      break
    case 'input_audio_buffer.speech_started':
      // 打断：取消进行中的回复并清空本地播放队列
      if (call.responding) {
        send(call, { type: 'response.cancel' })
      }
      call.player.flush()
      useRealtime.setState({ speaking: 'user' })
      break
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
      // 防御：服务端未给上一轮发 done 就开新轮时，先把旧回复按已停止收尾
      if (call.reply) {
        finishResponse(call, 'stopped')
      }
      const reply = appendRealtimeReply(call.sessionId, call.model)
      call.reply = reply
      call.responding = true
      useRealtime.setState({ speaking: 'assistant' })
      if (reply) {
        patchRealtimeReply(call.sessionId, reply.id, (existing) => ({
          ...existing,
          status: 'streaming',
        }))
      }
      break
    }
    case 'response.audio_transcript.delta': {
      const delta = readString(event.delta)
      if (delta) {
        appendReplyText(call, delta)
      }
      break
    }
    case 'response.audio.delta': {
      const delta = readString(event.delta)
      if (delta) {
        call.player.push(base64ToBytes(delta))
      }
      break
    }
    case 'response.done':
      finishResponse(call, event.response?.status === 'cancelled' ? 'stopped' : 'done')
      break
    case 'error':
      failCall(call, describeServerError(event.error))
      break
    default:
      // 其余事件（output_item/content_part 等）不影响转写与播放，忽略
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
  const { apiKey, realtimeModel, realtimeVoice } = useSettings.getState()
  const model = realtimeModel ?? useModels.getState().realtimeModels[0]?.id
  if (!apiKey || !model) {
    return false
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
    controller,
    socket,
    player,
    recording: null,
    model,
    reply: null,
    responding: false,
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
    voice: realtimeVoice,
    muted: false,
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
  if (call && !call.ended) {
    send(call, { type: 'session.update', session: sessionConfig(call) })
  }
}

/** 切换实时模型：以新模型重连（已落会话的转写保留，服务端上下文重置） */
export const changeRealtimeModel = (model: string) => {
  setRealtimeModel(model)
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
