import * as db from './db.js'
import { useChatStore } from './store.js'
import type { Session, SessionSummary } from './types.js'

/** 内容匹配片段：text 为截取窗口，start/end 为窗口内首个匹配区间，供高亮。 */
export type SearchSnippet = { text: string; start: number; end: number }

export type SessionSearchResult = { session: SessionSummary; snippet?: SearchSnippet }

/** 匹配位置前后各保留的字符数 */
const SNIPPET_RADIUS = 40

/** 搜索用纯文本：用户提问与回答正文（跳过服务端模板、思考与工具块），覆盖所有分支。 */
const extractSearchText = (session: Session): string =>
  session.messages
    .map((message) =>
      message.role === 'user'
        ? message.content
        : message.blocks
            .map((block) => (block.type === 'text' && !block.isTemplate ? block.text : ''))
            .join('')
    )
    .filter(Boolean)
    .join('\n')

/** 按 updatedAt 缓存已提取文本；会话删除或导入替换后在下次搜索时清理。 */
const textCache = new Map<string, { updatedAt: number; text: string }>()

const makeSnippet = (text: string, index: number, length: number): SearchSnippet => {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  return { text: text.slice(start, end), start: index - start, end: index + length - start }
}

/**
 * 搜索会话：标题匹配走内存列表，内容匹配逐会话提取纯文本。
 * 已缓存详情的会话直接读内存（比磁盘新，流式内容也可搜）；其余按 updatedAt 复用文本缓存，
 * 未命中的经游标逐条读取。结果沿用列表的 updatedAt 降序，按会话去重。
 */
export const searchSessions = async (query: string): Promise<SessionSearchResult[]> => {
  const keyword = query.trim().toLowerCase()
  if (!keyword) {
    return []
  }
  const { sessions, sessionCache } = useChatStore.getState()
  const alive = new Set(sessions.map((session) => session.id))
  for (const id of textCache.keys()) {
    if (!alive.has(id)) {
      textCache.delete(id)
    }
  }
  const texts = new Map<string, string>()
  const skip = new Set<string>()
  for (const summary of sessions) {
    const cached = Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : undefined
    if (cached) {
      const text = extractSearchText(cached)
      texts.set(summary.id, text)
      textCache.set(summary.id, { updatedAt: cached.updatedAt, text })
      skip.add(summary.id)
      continue
    }
    const entry = textCache.get(summary.id)
    if (entry && entry.updatedAt === summary.updatedAt) {
      texts.set(summary.id, entry.text)
      skip.add(summary.id)
    }
  }
  // 扫描失败（如存储不可用）时仍返回标题与已缓存文本的匹配结果。
  await db
    .scanSessions(skip, (session) => {
      const text = extractSearchText(session)
      texts.set(session.id, text)
      textCache.set(session.id, { updatedAt: session.updatedAt, text })
    })
    .catch(db.reportStorageError('scan sessions for search'))
  const results: SessionSearchResult[] = []
  for (const summary of sessions) {
    const titleMatch = summary.title.toLowerCase().includes(keyword)
    const text = texts.get(summary.id)
    const index = text ? text.toLowerCase().indexOf(keyword) : -1
    if (!titleMatch && index < 0) {
      continue
    }
    results.push({
      session: summary,
      snippet: text && index >= 0 ? makeSnippet(text, index, keyword.length) : undefined,
    })
  }
  return results
}
