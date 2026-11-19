import type { Message, Session } from './types.js'

/** 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。 */
export const normalizeSession = (session: Session): Session =>
  session.rootMessageId !== undefined
    ? session
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

/** 一次遍历收集兄弟版本；版本列表未变化时复用旧对象与索引，避免流式正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>
): ReadonlyMap<string, MessageVersions> => {
  const groups = new Map<string | null | undefined, string[]>()
  for (const message of session.messages) {
    const key = session.rootMessageId === undefined ? message.id : message.parentId
    const ids = groups.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      groups.set(key, [message.id])
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === session.messages.length
  for (const ids of groups.values()) {
    const cachedIds = previous.get(ids[0])?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    ids.forEach((id, index) => {
      const cached = previous.get(id)
      const version =
        cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
      versions.set(id, version)
      if (version !== cached) {
        unchanged = false
      }
    })
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  return {
    ...session,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  return {
    ...session,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}

/**
 * 删除消息及其全部后代（含其他分支上的后续对话），保持树完整：不产生悬空 parentId，
 * 幸存节点指向被删子节点的选择回退到创建顺序最近的幸存兄弟（优先前一个），无兄弟则清除。
 * 删除根消息时会话清空；摘要锚点被删时一并清除摘要。消息不存在返回 null。
 */
export const removeMessageSubtree = (original: Session, messageId: string): Session | null => {
  const session = normalizeSession(original)
  if (!session.messages.some((message) => message.id === messageId)) {
    return null
  }
  const children = new Map<string, string[]>()
  for (const message of session.messages) {
    if (message.parentId) {
      const ids = children.get(message.parentId)
      if (ids) {
        ids.push(message.id)
      } else {
        children.set(message.parentId, [message.id])
      }
    }
  }
  const removed = new Set([messageId])
  const queue = [messageId]
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (!removed.has(child)) {
        removed.add(child)
        queue.push(child)
      }
    }
  }
  const survivors = session.messages.filter((message) => !removed.has(message.id))
  const messages = survivors.map((message) => {
    const selected = message.selectedChildId
    if (!selected || !removed.has(selected)) {
      return message
    }
    const siblings = children.get(message.id) ?? []
    const position = siblings.indexOf(selected)
    const fallback =
      siblings.slice(0, position).findLast((id) => !removed.has(id)) ??
      siblings.slice(position + 1).find((id) => !removed.has(id))
    const next = { ...message }
    if (fallback) {
      next.selectedChildId = fallback
    } else {
      delete next.selectedChildId
    }
    return next
  })
  const next: Session = {
    ...session,
    messages,
    rootMessageId:
      session.rootMessageId && removed.has(session.rootMessageId) ? null : session.rootMessageId,
  }
  if (session.contextSummary && removed.has(session.contextSummary.anchorMessageId)) {
    delete next.contextSummary
  }
  return next
}
