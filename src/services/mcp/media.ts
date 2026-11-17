import { createId } from '../../utils/id.js'
import * as db from '../chat/db.js'
import type { McpMedia } from '../chat/types.js'
import type { McpContent } from './client.js'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#]|$)/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i
/** 视频原件本地保存上限，超过只保留远程引用 */
const MAX_LOCAL_VIDEO_BYTES = 200 * 1024 * 1024

export const mediaKindOf = (
  mimeType: string | undefined,
  url: string
): 'image' | 'video' | null => {
  if (mimeType?.startsWith('image/')) {
    return 'image'
  }
  if (mimeType?.startsWith('video/')) {
    return 'video'
  }
  if (IMAGE_EXT.test(url)) {
    return 'image'
  }
  if (VIDEO_EXT.test(url)) {
    return 'video'
  }
  return null
}

/** CSP connect-src 不含 data:，不能用 fetch(dataUrl) 解码，手动转 Blob */
const base64ToBlob = (data: string, mimeType: string): Blob => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

export const nameFromUrl = (url: string, kind: 'image' | 'video') => {
  try {
    const last = new URL(url).pathname.split('/').pop()
    if (last && last.includes('.')) {
      return last
    }
  } catch {
    // 非法 URL 用默认名
  }
  return kind === 'video' ? 'video.mp4' : 'image.png'
}

const saveBlob = async (blob: Blob): Promise<string | null> => {
  const id = createId()
  try {
    await db.saveFiles([{ id, blob }])
    return id
  } catch {
    // 存储失败（如配额不足）保留远程引用
    return null
  }
}

/** 尽力抓取远程媒体落盘；CORS、混合内容或体积超限时只保留远程地址。 */
export const persistRemoteMedia = async (
  url: string,
  kind: 'image' | 'video',
  mimeType: string | undefined,
  signal?: AbortSignal
): Promise<McpMedia> => {
  let fileId: string | null = null
  let size: number | undefined
  try {
    const response = await fetch(url, { signal })
    if (response.ok) {
      const blob = await response.blob()
      if (kind === 'image' || blob.size <= MAX_LOCAL_VIDEO_BYTES) {
        fileId = await saveBlob(blob)
        size = blob.size
      }
    }
  } catch {
    // 抓取失败保留远程引用
  }
  return {
    kind,
    fileId,
    url,
    mimeType: mimeType || (kind === 'video' ? 'video/mp4' : ''),
    name: nameFromUrl(url, kind),
    size,
  }
}

/**
 * 提取 MCP 结果内容里的媒体并落盘：base64 图片直接存原件；
 * resource_link / resource 按 MIME 或扩展名识别图片/视频，尽力抓取落盘。
 * 文本项拼接后回传模型；其中的 http(s) 地址兼作落盘失败媒体的兜底引用。
 */
export const extractMedia = async (
  content: McpContent[],
  signal?: AbortSignal
): Promise<{ media: McpMedia[]; text: string }> => {
  const media: McpMedia[] = []
  const texts: string[] = []
  const urls: string[] = []
  for (const item of content) {
    if (item.type === 'text') {
      texts.push(item.text)
      const matches = item.text.match(/https?:\/\/[^\s"'<>]+/g)
      if (matches) {
        urls.push(...matches)
      }
      continue
    }
    if (item.type === 'image') {
      const blob = base64ToBlob(item.data, item.mimeType)
      const fileId = await saveBlob(blob)
      const ext = (item.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg')
      media.push({
        kind: 'image',
        fileId,
        url: '',
        mimeType: item.mimeType,
        name: `mcp-${createId().slice(0, 8)}.${ext}`,
        size: blob.size,
      })
      continue
    }
    const uri = item.type === 'resource_link' ? item.uri : item.resource.uri
    const mimeType = item.type === 'resource_link' ? item.mimeType : item.resource.mimeType
    const kind = mediaKindOf(mimeType, uri)
    if (!kind) {
      const embedded = item.type === 'resource' ? item.resource.text : undefined
      texts.push(embedded ?? uri)
      continue
    }
    const blobData = item.type === 'resource' ? item.resource.blob : undefined
    if (blobData) {
      const blob = base64ToBlob(blobData, mimeType ?? '')
      const fileId = await saveBlob(blob)
      media.push({
        kind,
        fileId,
        url: /^https?:/.test(uri) ? uri : '',
        mimeType: mimeType ?? '',
        name: nameFromUrl(uri, kind),
        size: blob.size,
      })
    } else if (/^https?:/.test(uri)) {
      media.push(await persistRemoteMedia(uri, kind, mimeType, signal))
    } else {
      texts.push(uri)
    }
  }
  // 落盘失败且没有远程地址的媒体，用文本里的同类地址兜底
  let urlIndex = 0
  for (const item of media) {
    if (!item.fileId && !item.url) {
      while (urlIndex < urls.length) {
        const url = urls[urlIndex]
        urlIndex += 1
        if (mediaKindOf(undefined, url) === item.kind) {
          item.url = url
          break
        }
      }
    }
  }
  return { media, text: texts.join('\n') }
}
