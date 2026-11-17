import { callMcpTool, type McpCallResult } from './client.js'

/**
 * 视频生成为异步任务：generate_video* 立即返回 task_id，
 * 客户端代为轮询 get_video_task 直到终态，避免模型逐轮轮询消耗大量请求。
 */
const VIDEO_SUBMIT_TOOLS = new Set([
  'generate_video',
  'generate_video_from_frames',
  'generate_video_from_reference',
])
const POLL_INTERVAL_MS = 8000
/** 轮询总期限，与工具调用超时一致 */
const POLL_DEADLINE_MS = 4_000_000
/** 进行中的状态词（大写比较）；其余视为终态 */
const IN_PROGRESS = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'PENDING',
  'PROCESSING',
  'RUNNING',
  'SUBMITTED',
  'WAITING',
])

export const isVideoSubmitTool = (name: string) => VIDEO_SUBMIT_TOOLS.has(name)

export type VideoTask = {
  task_id?: string
  status?: string
  progress?: string
  result_url?: string
  proxy_url?: string
  fail_reason?: string
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** 任务字段在文本项的 JSON 里；解析不出返回 null */
export const readVideoTask = (result: McpCallResult): VideoTask | null => {
  for (const item of result.content) {
    if (item.type !== 'text') {
      continue
    }
    try {
      const value: unknown = JSON.parse(item.text)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (typeof record.task_id === 'string' || typeof record.status === 'string') {
          return {
            task_id: optionalString(record.task_id),
            status: optionalString(record.status),
            progress: optionalString(record.progress),
            result_url: optionalString(record.result_url),
            proxy_url: optionalString(record.proxy_url),
            fail_reason: optionalString(record.fail_reason),
          }
        }
      }
    } catch {
      // 非 JSON 文本
    }
  }
  return null
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
  })

/** 轮询到终态、出错或超期；超期返回最近一次结果，由模型决定如何回复。 */
export const pollVideoTask = async (
  apiKey: string,
  taskId: string,
  signal: AbortSignal | undefined,
  onProgress?: (progress: string) => void
): Promise<McpCallResult> => {
  const deadline = Date.now() + POLL_DEADLINE_MS
  for (;;) {
    await sleep(POLL_INTERVAL_MS, signal)
    const result = await callMcpTool(apiKey, 'get_video_task', { task_id: taskId }, signal)
    const task = readVideoTask(result)
    if (task?.progress) {
      onProgress?.(task.progress)
    }
    if (result.isError || !task || task.result_url) {
      return result
    }
    const status = task.status?.toUpperCase()
    if ((status && !IN_PROGRESS.has(status)) || Date.now() >= deadline) {
      return result
    }
  }
}
