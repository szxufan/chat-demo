import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  collectFileIds,
  toSessionSummary,
  type Folder,
  type Session,
  type SessionSummary,
} from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 13

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及发送时内联。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/**
 * 未发送的草稿。新对话的 null 会话键编码为 '__new__'。
 * 附件存 File 原件（结构化克隆），previewUrl 不持久化，加载时用 URL.createObjectURL 重建。
 */
export type StoredDraft = {
  id: string
  text: string
  /** 仅新对话记录保存；undefined 表示跟随全局，'' 是有意义的显式覆盖。 */
  newChatSystemPrompt?: string
  attachments: { id: string; file: File; isImage: boolean }[]
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 会话分组 */
  folders: { key: string; value: Folder }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /** 未发送的草稿，按会话 id 存储（新对话编码为 '__new__'） */
  drafts: { key: string; value: StoredDraft }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [...collectFileIds(session.messages)],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'folders',
        'drafts',
        'sessionsStaging',
        'filesStaging',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

/** 逐条游标遍历会话详情供全文搜索；skipIds 内的会话不读取值，避免反序列化整条记录。 */
export const scanSessions = async (
  skipIds: ReadonlySet<string>,
  visit: (session: Session) => void
): Promise<void> => {
  const tx = (await getDB()).transaction('sessions', 'readonly')
  for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
    if (!skipIds.has(cursor.key)) {
      visit(cursor.value)
    }
  }
  await tx.done
}

/** 保存会话；pruneFileIds 为本次删除消息后不再被引用的原件候选，同事务内确认无会话引用后清理。 */
export const saveSession = async (
  session: Session,
  files: StoredFile[] = [],
  pruneFileIds: string[] = []
): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        const summaries = tx.objectStore('sessionSummaries')
        await summaries.put(summary)
        for (const id of pruneFileIds) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可设置系统提示词；摘要不变，只更新详情。undefined 表示清除覆盖。 */
export const setSessionSystemPrompt = async (
  id: string,
  systemPrompt: string | undefined
): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          if (systemPrompt === undefined) {
            delete session.systemPrompt
          } else {
            session.systemPrompt = systemPrompt
          }
          await sessions.put(session)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const loadFolders = async (): Promise<Folder[]> => (await getDB()).getAll('folders')

export const saveFolder = async (folder: Folder): Promise<void> => {
  await (await getDB()).put('folders', folder)
}

/** 未打开的会话也可移动分组，原子更新详情和列表。undefined 表示移出分组。 */
export const setSessionFolder = async (id: string, folderId: string | undefined): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          if (folderId === undefined) {
            delete session.folderId
          } else {
            session.folderId = folderId
          }
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除分组并把组内会话移回未分组；同一事务完成，不删除会话。 */
export const removeFolder = async (folderId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['folders', 'sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await tx.objectStore('folders').delete(folderId)
        const summaries = tx.objectStore('sessionSummaries')
        for (
          let cursor = await tx.objectStore('sessions').openCursor();
          cursor;
          cursor = await cursor.continue()
        ) {
          const session = cursor.value
          if (session.folderId === folderId) {
            delete session.folderId
            await cursor.update(session)
            await summaries.put(storedSummary(session))
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

export const loadDrafts = async (): Promise<StoredDraft[]> => (await getDB()).getAll('drafts')

export const saveDraft = async (draft: StoredDraft): Promise<void> => {
  await (await getDB()).put('drafts', draft)
}

export const deleteDraft = async (id: string): Promise<void> => {
  await (await getDB()).delete('drafts', id)
}

export const clearDrafts = async (): Promise<void> => {
  await (await getDB()).clear('drafts')
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/** 导入的会话可能引用归档中不存在的分组（条目乱序或手工归档），提交前统一清除引用。 */
export const pruneStagingFolderIds = async (validIds: ReadonlySet<string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        if (session.folderId !== undefined && !validIds.has(session.folderId)) {
          delete session.folderId
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要、分组和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 * 分组元数据很小，校验后直接传入，在同一事务中整体替换。
 */
export const commitStaging = async (folders: Folder[]): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'folders', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  const replaceFolders = async () => {
    try {
      const target = tx.objectStore('folders')
      await target.clear()
      for (const folder of folders) {
        await target.put(folder)
      }
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([
    move('sessionsStaging', 'sessions'),
    move('filesStaging', 'files'),
    replaceFolders(),
    tx.done,
  ])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
