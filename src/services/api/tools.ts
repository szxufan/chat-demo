import { ApiError, API_ORIGIN, request } from './client.js'

/**
 * 搜索与链接阅读工具（客户端工具循环里执行）：
 * - 搜索：POST /v1/tools/search，返回网页摘要列表
 * - 抓取：POST /v1/tools/fetch，返回网页明文正文
 * 鉴权都用 Authorization: Bearer。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 搜索结果里展示与回传需要的字段；snippet 缺省时退回 summary */
export type WebSearchHit = {
  title: string
  url: string
  snippet: string
  site_name: string | null
  site_icon: string | null
  page_age: string | null
}

/** 缺少 url/title 的条目整条丢弃 */
const readHit = (value: unknown): WebSearchHit | null => {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.title !== 'string') {
    return null
  }
  const optionalString = (field: unknown) => (typeof field === 'string' ? field : null)
  return {
    title: value.title,
    url: value.url,
    snippet:
      typeof value.snippet === 'string'
        ? value.snippet
        : typeof value.summary === 'string'
          ? value.summary
          : '',
    site_name: optionalString(value.site_name),
    site_icon: optionalString(value.site_icon),
    page_age: optionalString(value.date),
  }
}

export const searchWeb = async (
  apiKey: string,
  query: string,
  signal?: AbortSignal
): Promise<WebSearchHit[]> => {
  const response = await request(`${TOOLS_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new ApiError('protocol', 'Unexpected /v1/tools/search response')
  }
  return body.results.map(readHit).filter((hit): hit is WebSearchHit => hit !== null)
}

export type WebFetchPage = { content: string; title: string | null }

export const fetchUrl = async (
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<WebFetchPage> => {
  const response = await request(`${TOOLS_BASE_URL}/fetch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || typeof body.content !== 'string') {
    throw new ApiError('protocol', 'Unexpected /v1/tools/fetch response')
  }
  return {
    content: body.content,
    title: typeof body.title === 'string' ? body.title : null,
  }
}
