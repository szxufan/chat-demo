/**
 * 麦克风采集链：单声道、回声消除、降噪，AudioContext 以 16kHz 创建由浏览器重采样，
 * ScriptProcessorNode 采集 PCM 样本。两种模式：
 * - startRecording：累积整段录音并编码为 ASR 接受的 WAV（单声道、16-bit PCM、16kHz）；
 * - startStreamingRecording：按 100ms 分帧输出裸 PCM，供实时语音持续上行。
 * 录音处理在页面内完成。
 */
export const SAMPLE_RATE = 16000
/** ASR 单次时长上限 120 秒 */
export const MAX_SECONDS = 120

const BUFFER_SIZE = 4096
/** 实时输入帧长：100ms @16kHz 16-bit 单声道 = 3200 字节 */
const FRAME_BYTES = 3200

type Capture = {
  analyser: AnalyserNode
  processor: ScriptProcessorNode
  release: () => void
}

/** 建立采集链；调用方负责设置 processor.onaudioprocess 并在结束时 release */
const createCapture = async (): Promise<Capture> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }
    released = true
    if (processor) {
      processor.onaudioprocess = null
    }
    // 初始化可能只完成了一部分；单个节点断开失败也不能阻止麦克风释放。
    for (const node of [processor, analyser, source]) {
      try {
        node?.disconnect()
      } catch {
        // 继续释放其余资源。
      }
    }
    for (const track of stream.getTracks()) {
      track.stop()
    }
    void context?.close().catch(() => {})
  }

  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE })
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    // 频谱分析用：串在录音链路中间（原样透传），WebKit 不会处理未连到输出的分析节点
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    source.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 只有连到输出才会持续回调；输出缓冲保持静音
    processor.connect(context.destination)
    // 在 await getUserMedia 之后创建，iOS 上可能处于 suspended
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }
    return { analyser, processor, release }
  } catch (error) {
    release()
    throw error
  }
}

export type Recording = {
  /** 停止录音并返回 WAV；没有采到声音时返回 null */
  stop: () => Promise<Blob | null>
  /** 放弃录音，释放麦克风 */
  cancel: () => void
  /** 频谱分析节点，只读；采样率与录音一致 */
  analyser: AnalyserNode
}

/** 开始录音；到达时长上限时调用 onLimit，由调用方决定何时 stop */
export const startRecording = async (onLimit: () => void): Promise<Recording> => {
  const capture = await createCapture()
  const chunks: Float32Array[] = []
  let length = 0
  let limited = false
  capture.processor.onaudioprocess = (event) => {
    if (limited) {
      return
    }
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    length += BUFFER_SIZE
    if (length >= MAX_SECONDS * SAMPLE_RATE) {
      limited = true
      onLimit()
    }
  }

  return {
    stop: async () => {
      capture.release()
      return length === 0 ? null : encodeWav(chunks, length)
    },
    cancel: capture.release,
    analyser: capture.analyser,
  }
}

export type StreamingRecording = {
  /** 停止采集并释放麦克风 */
  stop: () => void
  /** 频谱分析节点，只读；采样率与采集一致 */
  analyser: AnalyserNode
}

/**
 * 开始流式采集：每 100ms 回调一帧 16-bit 小端裸 PCM。
 * 无客户端时长上限，实时会话时长由服务端限制。
 */
export const startStreamingRecording = async (
  onFrame: (frame: Uint8Array) => void
): Promise<StreamingRecording> => {
  const capture = await createCapture()
  let pending = new Uint8Array(0)
  capture.processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const bytes = new Uint8Array(input.length * 2)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]))
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
    // 与上一段残留拼接后按 100ms 帧输出，不足一帧的部分留到下次回调
    const merged = new Uint8Array(pending.length + bytes.length)
    merged.set(pending)
    merged.set(bytes, pending.length)
    let offset = 0
    while (offset + FRAME_BYTES <= merged.length) {
      onFrame(merged.slice(offset, offset + FRAME_BYTES))
      offset += FRAME_BYTES
    }
    pending = merged.slice(offset)
  }

  return { stop: capture.release, analyser: capture.analyser }
}

const encodeWav = (chunks: Float32Array[], length: number) => {
  const samples = Math.min(length, MAX_SECONDS * SAMPLE_RATE)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  let written = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && written < samples; i++, written++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
