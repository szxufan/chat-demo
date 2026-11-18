import { ApiError, API_ORIGIN, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import { toSpeechText } from '../markdown/speech.js'
import { base64ToBytes } from '../speech/pcm.js'
import { isMimoAsrModel, isMimoTtsModel } from '../speech/ttsVoices.js'

/**
 * 语音接口（按所选模型提供商分支）：
 * - MiMo：OpenAI 兼容端点 /v1/audio/speech（裸 PCM 或 SSE Base64）、/v1/audio/transcriptions（{text}）
 * - DeepSeek（默认兜底）：原生 /v1/tools/tts（音频字节流）、/v1/tools/asr（{text}）
 * 鉴权都用 Authorization: Bearer。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`
const AUDIO_BASE_URL = `${API_ORIGIN}/v1/audio`

export type TtsVoice = string

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端（MiMo 与 DeepSeek 一致） */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal,
  model?: string | null
): Promise<string> => {
  const mimo = isMimoAsrModel(model ?? null)
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  if (mimo && model) {
    form.append('model', model)
  }
  const response = await request(
    mimo ? `${AUDIO_BASE_URL}/transcriptions` : `${TOOLS_BASE_URL}/asr`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    }
  )
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 读取标准 speech.audio.delta 或 MiMo chat.completion.chunk 中的 Base64 音频；结束帧没有音频 */
const readMimoAudioData = (raw: string): string | null => {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (!isRecord(body)) {
    throw new ApiError('protocol', raw)
  }
  if (isRecord(body.error) && typeof body.error.message === 'string') {
    throw new ApiError(
      'stream',
      body.error.message,
      undefined,
      typeof body.error.code === 'string' ? body.error.code : undefined
    )
  }
  if (body.type === 'speech.audio.delta') {
    if (typeof body.audio !== 'string') {
      throw new ApiError('protocol', raw)
    }
    return body.audio
  }
  if (body.type === 'speech.audio.done') {
    return null
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    return null
  }
  const audio = choice.delta.audio
  if (audio === null || audio === undefined) {
    return null
  }
  if (!isRecord(audio) || typeof audio.data !== 'string') {
    throw new ApiError('protocol', raw)
  }
  return audio.data
}

async function* readMimoAudio(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  for await (const { data } of readServerSentEvents(stream, signal)) {
    if (data.trim() === '[DONE]') {
      return
    }
    const audio = readMimoAudioData(data)
    if (!audio) {
      continue
    }
    try {
      yield base64ToBytes(audio)
    } catch {
      throw new ApiError('protocol', 'Invalid Base64 audio chunk')
    }
  }
}

/** 把异步迭代器接成浏览器 ReadableStream，并保留下游取消与上游错误 */
const fromAsyncIterable = <T>(iterable: AsyncIterable<T>): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/**
 * 语音合成：返回裸 PCM 字节流。
 * MiMo 走 /v1/audio/speech（stream_format=sse），先去除 Markdown；响应为裸 PCM 时直传，为 SSE 时解码其中的 Base64 PCM；
 * DeepSeek 走 /v1/tools/tts，由服务端默认过滤代码块、表格、引用标记与长公式。
 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal,
  model?: string | null
): Promise<ReadableStream<Uint8Array>> => {
  const mimo = isMimoTtsModel(model ?? null)
  const body = mimo
    ? JSON.stringify({
        model,
        input: toSpeechText(text),
        voice,
        response_format: 'pcm',
        stream_format: 'sse',
      })
    : JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true })
  const response = await request(mimo ? `${AUDIO_BASE_URL}/speech` : `${TOOLS_BASE_URL}/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(mimo ? { Accept: 'text/event-stream' } : {}),
    },
    body,
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  if (!mimo) {
    return response.body
  }
  // 网关可能直接返回裸 PCM（audio/pcm），也可能按 OpenAI 规范返回 SSE Base64；按 Content-Type 分支
  if ((response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    return fromAsyncIterable(readMimoAudio(response.body, signal))
  }
  return response.body
}
