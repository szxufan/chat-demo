import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { translate } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { ApiError, requestSummary, requestTitle, streamChatCompletion } from '../api/client.js'
import { isContextOverflowError } from '../api/errors.js'
import type { ChatMessageParam, ChatModel, ChatToolCall } from '../api/types.js'
import { readImageDataUrl } from '../attachments.js'
import { useModels } from '../models.js'
import { useSettings } from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import {
  chunkRoundsForSummary,
  contextBudget,
  estimateRoundTokens,
  estimateTextTokens,
  estimateUserTokens,
  MESSAGE_OVERHEAD,
  planTrimBoundary,
  resolveWindow,
  serializeRoundsForSummary,
  type ContextRound,
} from './context.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyChunk,
  canContinueReply,
  getContextRounds,
  getReplyText,
  mergeToolCallDeltas,
  settleReply,
  toOpenAIMessages,
} from './reply.js'
import { executeToolCall, searchTools } from './tools.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 模型列表来自上游 GET /v1/models；此值仅在列表不可用时兜底 */
const DEFAULT_MODEL: ChatModel = 'deepseek-v4-flash'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启 */
const SAFETY_CHECK = { level: 'high' } as const
/** 客户端工具循环（搜索/链接阅读）最多轮数；超过按 tool_use 收尾，禁止续写 */
const TOOL_ROUND_LIMIT = 5
/** 上下文超限后的原地重试次数；每次窗口减半并截断工具结果 */
const MAX_OVERFLOW_RETRIES = 2
/** 超限重试时工具结果内容的字符上限 */
const TOOL_RETRY_CHAR_CAP = 6000

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
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
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前设置创建回复：模型与思考强度取全局选择，深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model, thinkingEffort } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: model ?? DEFAULT_MODEL,
    thinking,
    effort: thinkingEffort ?? undefined,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/** 设置会话级系统提示词；undefined 表示清除覆盖、跟随全局设置。 */
export const setSessionSystemPrompt = (id: string, systemPrompt: string | undefined) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => {
      const next = { ...session }
      if (systemPrompt === undefined) {
        delete next.systemPrompt
      } else {
        next.systemPrompt = systemPrompt
      }
      return next
    })
    persist(id)
  } else {
    void db
      .setSessionSystemPrompt(id, systemPrompt)
      .catch(db.reportStorageError('set session system prompt'))
  }
}

/** 读取会话的系统提示词覆盖；详情未缓存时先加载，null 表示读取失败。 */
export const readSessionSystemPrompt = async (
  id: string
): Promise<{ systemPrompt?: string } | null> => {
  await ensureSessionLoaded(id)
  const session = getSession(id)
  return session ? { systemPrompt: session.systemPrompt } : null
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId))
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search, thinkingEffort } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? DEFAULT_MODEL,
    thinking: previous.thinking ?? thinking,
    effort: previous.effort ?? thinkingEffort ?? undefined,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/**
 * 发送前把图片内联为 base64：本轮提问与进入上下文的历史轮次里的图片读本地原件；
 * 没有原件的附件（导入的元数据）只展示、不进入请求；读取失败的图片跳过。
 */
const prepareImages = async (
  request: Request,
  signal: AbortSignal
): Promise<Map<string, string>> => {
  const files = new Map<string, UserMessage['files'][number]>()
  const add = (list: UserMessage['files']) => {
    for (const file of list) {
      if (file.isImage && !files.has(file.id)) {
        files.set(file.id, file)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  const images = new Map<string, string>()
  await Promise.all(
    [...files.values()].map(async (file) => {
      const blob = await db.loadFile(file.id)
      if (!blob || signal.aborted) {
        return
      }
      try {
        images.set(file.id, await readImageDataUrl(blob))
      } catch {
        // 原件读不出时跳过该图片，不进入请求
      }
    })
  )
  signal.throwIfAborted()
  return images
}

/** 超限重试时截断工具结果内容，控制上下文开销 */
const capToolContent = (messages: ChatMessageParam[]): ChatMessageParam[] =>
  messages.map((message) =>
    message.role === 'tool' && message.content.length > TOOL_RETRY_CHAR_CAP
      ? { ...message, content: message.content.slice(0, TOOL_RETRY_CHAR_CAP) }
      : message
  )

/** 滚动压缩：分块把早期轮次折叠进摘要；任一块失败返回 null，由调用方放弃本次主动裁剪 */
const compressRounds = async (
  apiKey: string,
  model: ChatModel,
  previousSummary: string,
  rounds: ContextRound[],
  signal: AbortSignal
): Promise<string | null> => {
  let summary = previousSummary
  for (const chunk of chunkRoundsForSummary(rounds)) {
    const serialized = serializeRoundsForSummary(chunk)
    const input = summary
      ? `Previous summary:\n${summary}\n\nNew conversation:\n${serialized}`
      : serialized
    const next = await requestSummary(apiKey, model, input, signal).catch(() => null)
    if (next === null) {
      return null
    }
    summary = next
  }
  return summary
}

/**
 * 上下文预算：未超预算不裁剪（前缀 append-only 增长，利于 KV Cache 命中）；
 * 超预算时保留最近 KEEP_ROUNDS 轮，更早轮次经 LLM 压缩为会话摘要并持久化。
 * 压缩失败则放弃主动裁剪按原样发送，交给超限重试兜底。
 * 返回实际进入请求的历史与折入摘要的 system 文本。
 */
const fitContext = async (
  sessionId: string,
  request: Request,
  systemText: string,
  model: ChatModel,
  apiKey: string,
  signal: AbortSignal
): Promise<{ history: Message[]; systemText: string }> => {
  const rounds = getContextRounds(request.history)
  const summary = getSession(sessionId)?.contextSummary
  const { window, anchorIndex } = resolveWindow(rounds, summary?.anchorMessageId)
  if (summary && anchorIndex < 0) {
    // 锚点不在当前路径（切换分支、编辑早期消息）：摘要失效
    updateSession(sessionId, (session) => ({ ...session, contextSummary: undefined }))
    persist(sessionId)
  }
  const coveredCount = anchorIndex + 1
  const summaryText = anchorIndex >= 0 ? (summary?.text ?? '') : ''
  const withSummary = (text: string) =>
    text ? [systemText, `${translate('contextSummaryLabel')}\n${text}`].join('\n') : systemText
  const budget = contextBudget(useModels.getState().models.find((item) => item.id === model))
  const fixedTokens =
    estimateTextTokens(withSummary(summaryText)) +
    MESSAGE_OVERHEAD +
    estimateUserTokens(request.question) +
    (request.prefix ? estimateTextTokens(getReplyText(request.prefix)) + MESSAGE_OVERHEAD : 0)
  const windowTokens = window.reduce((sum, round) => sum + estimateRoundTokens(round), 0)
  if (budget === null || fixedTokens + windowTokens <= budget) {
    return { history: window.flat(), systemText: withSummary(summaryText) }
  }
  const boundary = planTrimBoundary(rounds, coveredCount, fixedTokens, budget)
  const toCompress = rounds.slice(coveredCount, boundary)
  if (toCompress.length === 0) {
    // 窗口已无可压缩轮次：按原样发送，交给超限重试
    return { history: window.flat(), systemText: withSummary(summaryText) }
  }
  showToast({ key: 'contextCompressingToast' })
  const text = await compressRounds(apiKey, model, summaryText, toCompress, signal)
  if (text === null) {
    if (!signal.aborted) {
      showToast({ key: 'contextCompressFailedToast' })
    }
    return { history: window.flat(), systemText: withSummary(summaryText) }
  }
  const anchorMessageId = rounds[boundary - 1][1].id
  updateSession(sessionId, (session) => ({ ...session, contextSummary: { text, anchorMessageId } }))
  persist(sessionId)
  return { history: rounds.slice(boundary).flat(), systemText: withSummary(text) }
}

/**
 * 请求并消费流：先按上下文预算裁剪压缩，再内联图片发请求；流式增量按动画帧刷新内存，
 * 完成、失败或停止后落盘。模型发出 tool_calls（搜索/链接阅读）时由客户端执行并以 tool 消息
 * 回传结果继续生成，最多 TOOL_ROUND_LIMIT 轮；超过按 tool_use 收尾。
 * 上下文超限时机械裁剪原地重试。首轮完成后另发小请求补会话标题。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    const apiKey = useSettings.getState().apiKey ?? ''
    const model = initial.model ?? DEFAULT_MODEL
    const systemPrompt = getSession(sessionId)?.systemPrompt ?? useSettings.getState().systemPrompt
    // 续写沿用原回答快照，重新生成的快照独立保存。
    const latestReminder = request.prefix
      ? request.prefix.latestReminder
      : createLatestReminder(useSettings.getState())
    reply = { ...reply, latestReminder }
    updateReply(sessionId, reply)
    persist(sessionId)
    // latest_reminder 角色被网关拒绝，环境快照折进 system 消息
    const baseSystemText = [systemPrompt, latestReminder].filter(Boolean).join('\n')
    const fitted = await fitContext(
      sessionId,
      request,
      baseSystemText,
      model,
      apiKey,
      controller.signal
    )
    const imageData = await prepareImages(
      { ...request, history: fitted.history },
      controller.signal
    )
    let baseMessages = toOpenAIMessages(
      fitted.history,
      request.question,
      fitted.systemText,
      imageData,
      request.prefix
    )
    let toolMessages: ChatMessageParam[] = []
    let windowRounds = getContextRounds(fitted.history)
    const tools = searchTools(initial.search ?? false)
    let overflowRetries = 0

    for (let round = 0; ; ) {
      // 超限重试只丢弃本次请求的增量，保留此前已完成的工具调用与结果。
      const roundStartReply = reply
      const toolCalls = new Map<number, ChatToolCall>()
      let roundText = ''
      try {
        const events = streamChatCompletion(
          apiKey,
          {
            model,
            messages: [...baseMessages, ...toolMessages],
            stream: true,
            stream_options: { include_usage: true },
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            ...(initial.thinking && initial.effort ? { reasoning_effort: initial.effort } : {}),
            safety_check: SAFETY_CHECK,
            tools,
          },
          controller.signal
        )
        for await (const chunk of events) {
          for (const choice of chunk.choices) {
            if (choice.delta.tool_calls) {
              mergeToolCallDeltas(toolCalls, choice.delta.tool_calls)
            }
            if (choice.delta.content) {
              roundText += choice.delta.content
            }
          }
          reply = applyChunk(reply, chunk, Date.now())
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        const calls = [...toolCalls.values()].filter((call) => call.id && call.function.name)
        if (reply.stopReason === 'tool_use' && calls.length > 0 && round < TOOL_ROUND_LIMIT) {
          const executions = await Promise.all(
            calls.map((call) => executeToolCall(apiKey, call, controller.signal))
          )
          reply = {
            ...reply,
            blocks: [...reply.blocks, ...executions.flatMap((execution) => execution.blocks)],
            stopReason: undefined,
          }
          toolMessages = [
            ...toolMessages,
            { role: 'assistant', content: roundText || null, tool_calls: calls },
            ...executions.map((execution, index) => ({
              role: 'tool' as const,
              tool_call_id: calls[index].id,
              content: execution.message,
            })),
          ]
          flush()
          round += 1
          continue
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 finish_reason，只是缺了结尾的 [DONE]
          reply = settleReply(reply, 'done', Date.now())
          break
        }
        if (isContextOverflowError(error) && overflowRetries < MAX_OVERFLOW_RETRIES) {
          overflowRetries += 1
          // 窗口减半重建基础消息；锚点移到新边界（摘要文本不变，机械丢弃早期轮次）
          if (windowRounds.length > 0) {
            const allRounds = getContextRounds(request.history)
            const keep = Math.floor(windowRounds.length / 2)
            const boundary = Math.max(0, allRounds.length - keep)
            windowRounds = allRounds.slice(boundary)
            if (boundary > 0) {
              const anchorMessageId = allRounds[boundary - 1][1].id
              updateSession(sessionId, (session) => ({
                ...session,
                contextSummary: { text: session.contextSummary?.text ?? '', anchorMessageId },
              }))
              persist(sessionId)
            }
            baseMessages = toOpenAIMessages(
              windowRounds.flat(),
              request.question,
              fitted.systemText,
              imageData,
              request.prefix
            )
          }
          baseMessages = capToolContent(baseMessages)
          toolMessages = capToolContent(toolMessages)
          // 超限是请求级拒绝，只回滚本次请求的增量，从上一轮完成状态重发
          reply = roundStartReply
          flush()
          showToast({ key: 'contextTrimmedRetryToast' })
          continue
        }
        if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: isContextOverflowError(error)
              ? { key: 'replyContextOverflow' }
              : error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }

    // 网关不返回 title 扩展：回复完成后另发一次小请求概括标题。
    // 不等待标题请求，避免回答已结束但输入框仍处于生成中；手动重命名后不再覆盖。
    if (
      reply.status === 'done' &&
      titleRequests.has(controller) &&
      !controller.signal.aborted &&
      !get().importingHistory
    ) {
      titleRequests.delete(controller)
      void requestTitle(apiKey, model, request.question.content, getReplyText(reply))
        .then((title) => {
          if (!title || get().importingHistory) {
            return
          }
          updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
          persist(sessionId)
        })
        .catch(() => {})
    }
  } catch (error) {
    // 上下文压缩、图片读取阶段中止或意外错误
    if (controller.signal.aborted) {
      reply = settleReply(reply, 'stopped', Date.now())
    } else {
      reply = settleReply(reply, 'error', Date.now(), {
        kind: 'protocol',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
