import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { isImage, resolveMimeType, validateFiles } from '../attachments.js'
import * as db from './db.js'
import type { StoredDraft } from './db.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 新对话的 null 会话键在 IndexedDB 中的编码（null 不是合法的 keyPath 值）。 */
const NEW_CHAT_KEY = '__new__'
const toStorageKey = (sessionId: string | null) => sessionId ?? NEW_CHAT_KEY

/** 草稿独立持久化于 IndexedDB，与会话详情缓存分离；null 是新对话的草稿。 */
export const useDrafts = create<{
  drafts: Map<string | null, Draft>
  /** 尚未创建的新对话的系统提示词覆盖；undefined 表示跟随全局，首次发送创建会话后清除。 */
  newChatSystemPrompt: string | undefined
}>(() => ({
  drafts: new Map(),
  newChatSystemPrompt: undefined,
}))

// 每个会话独立防抖，避免每次按键都写 IndexedDB；写/删前读取最新内存态，过期写不会覆盖新内容。
const pendingWrites = new Map<string | null, ReturnType<typeof setTimeout>>()

const persistDraft = async (sessionId: string | null) => {
  const { drafts, newChatSystemPrompt } = useDrafts.getState()
  const draft = drafts.get(sessionId)
  const key = toStorageKey(sessionId)
  const hasContent = !!draft && (draft.text !== '' || draft.attachments.length > 0)
  const hasPrompt = sessionId === null && newChatSystemPrompt !== undefined
  try {
    if (!hasContent && !hasPrompt) {
      await db.deleteDraft(key)
      return
    }
    await db.saveDraft({
      id: key,
      text: draft?.text ?? '',
      ...(sessionId === null ? { newChatSystemPrompt } : {}),
      attachments: (draft?.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        file: attachment.file,
        isImage: attachment.isImage,
      })),
    })
  } catch (error) {
    db.reportStorageError('persist draft')(error)
  }
}

const schedulePersist = (sessionId: string | null) => {
  const existing = pendingWrites.get(sessionId)
  if (existing) {
    clearTimeout(existing)
  }
  pendingWrites.set(
    sessionId,
    setTimeout(() => {
      pendingWrites.delete(sessionId)
      void persistDraft(sessionId)
    }, 400)
  )
}

/** 发送/删除会话后立即移除持久化草稿，并取消尚未落盘的防抖写。 */
const removePersisted = (sessionId: string | null) => {
  const existing = pendingWrites.get(sessionId)
  if (existing) {
    clearTimeout(existing)
    pendingWrites.delete(sessionId)
  }
  void db.deleteDraft(toStorageKey(sessionId)).catch(db.reportStorageError('delete draft'))
}

/** 离开页面前调用：立即写出所有仍在防抖中的草稿，避免丢失最后几百毫秒的输入。 */
export const flushDraftPersistence = () => {
  const sessionIds = [...pendingWrites.keys()]
  for (const timeout of pendingWrites.values()) {
    clearTimeout(timeout)
  }
  pendingWrites.clear()
  for (const sessionId of sessionIds) {
    void persistDraft(sessionId)
  }
}

/** 用 IndexedDB 中的记录重建内存草稿，恢复附件预览与新对话系统提示词。 */
export const hydrateDrafts = (stored: StoredDraft[]) => {
  const drafts = new Map<string | null, Draft>()
  let newChatSystemPrompt: string | undefined
  for (const record of stored) {
    const sessionId = record.id === NEW_CHAT_KEY ? null : record.id
    const attachments = record.attachments.map((attachment): DraftAttachment => {
      return {
        id: attachment.id,
        file: attachment.file,
        isImage: attachment.isImage,
        previewUrl: attachment.isImage ? URL.createObjectURL(attachment.file) : null,
      }
    })
    if (record.text !== '' || attachments.length > 0) {
      drafts.set(sessionId, { text: record.text, attachments })
    }
    if (sessionId === null) {
      newChatSystemPrompt = record.newChatSystemPrompt
    }
  }
  useDrafts.setState({ drafts, newChatSystemPrompt })
}

export const setNewChatSystemPrompt = (systemPrompt: string | undefined) => {
  useDrafts.setState({ newChatSystemPrompt: systemPrompt })
  schedulePersist(null)
}

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) => {
  updateDraft(sessionId, (draft) => ({ ...draft, text }))
  schedulePersist(sessionId)
}

/** 整批校验通过后才创建预览；附件只存本地，发送时内联 base64。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[]
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  schedulePersist(sessionId)
  return null
}

/** 发送按钮和实际提交共用规则：有文字或有附件即可发送。 */
export const prepareDraftMessage = (draft: Draft) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { blob: Blob })[] = draft.attachments.map((attachment) => ({
    id: attachment.id,
    serverId: null,
    name: attachment.file.name,
    size: attachment.file.size,
    isImage: attachment.isImage,
    mimeType: resolveMimeType(attachment.file),
    blob: attachment.file,
  }))
  return { text, files }
}

const releaseAttachment = (attachment: DraftAttachment) => {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
  schedulePersist(sessionId)
}

/** 发送成功后原件已交给会话，释放预览并移除持久化草稿。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach(releaseAttachment)
  updateDraft(sessionId, () => EMPTY_DRAFT)
  if (sessionId === null) {
    setNewChatSystemPrompt(undefined)
  }
  removePersisted(sessionId)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach(releaseAttachment)
  updateDraft(sessionId, () => EMPTY_DRAFT)
  if (sessionId === null) {
    setNewChatSystemPrompt(undefined)
  }
  removePersisted(sessionId)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach(releaseAttachment)
  }
  useDrafts.setState({ drafts: new Map(), newChatSystemPrompt: undefined })
  for (const timeout of pendingWrites.values()) {
    clearTimeout(timeout)
  }
  pendingWrites.clear()
  void db.clearDrafts().catch(db.reportStorageError('clear drafts'))
}
