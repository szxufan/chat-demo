import { ApiError } from '../api/client.js'
import { callMcpTool } from './client.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export type McpUploadResult = {
  /** 临时图片 id，供 generate_image / generate_video_from_* 引用，有效期约 2 小时 */
  id: string
  /** 网关代理地址 */
  url: string
}

/**
 * 本地图片进入 MCP 工具的唯一通道：request_upload_ticket 取票，
 * 再 multipart POST 到 /v1/mcp-upload?ticket=…（票据鉴权，不带自定义头，无 CORS 预检）。
 */
export const uploadMcpImage = async (
  apiKey: string,
  blob: Blob,
  name: string,
  signal?: AbortSignal
): Promise<McpUploadResult> => {
  const ticketResult = await callMcpTool(apiKey, 'request_upload_ticket', {}, signal)
  const text = ticketResult.content.find((item) => item.type === 'text')?.text
  let info: unknown
  try {
    info = JSON.parse(text ?? '')
  } catch {
    throw new ApiError('protocol', 'Unexpected MCP upload ticket response')
  }
  if (!isRecord(info) || typeof info.ticket !== 'string' || typeof info.upload_url !== 'string') {
    throw new ApiError('protocol', 'Unexpected MCP upload ticket response')
  }
  const form = new FormData()
  form.append(typeof info.file_field === 'string' ? info.file_field : 'file', blob, name)
  const response = await fetch(`${info.upload_url}?ticket=${encodeURIComponent(info.ticket)}`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) {
    throw new ApiError('http', `MCP image upload failed: ${response.status}`, response.status)
  }
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || !isRecord(body.data) || typeof body.data.id !== 'string') {
    throw new ApiError('protocol', 'Unexpected MCP upload response')
  }
  return {
    id: body.data.id,
    url: typeof body.data.url === 'string' ? body.data.url : '',
  }
}
