import { toFloat32 } from './pcm.js'

/** 首帧前多缓冲一点，减少网络抖动造成的断续（与朗读一致） */
const START_DELAY = 0.1

/**
 * 流式 PCM 播放器：按到达顺序排程 AudioBufferSourceNode，首帧到达即出声。
 * AudioContext 必须由调用方在用户手势内同步创建（浏览器自动播放策略）。
 * flush 用于语音打断：停掉全部已排程音频并重置时间线。
 */
export class PcmPlayer {
  private nextTime = 0
  private started = false
  private readonly sources = new Set<AudioBufferSourceNode>()
  private rest = new Uint8Array(0)
  private disposed = false

  constructor(
    private readonly context: AudioContext,
    private readonly sampleRate: number
  ) {}

  /** 喂入一段 16-bit 小端 PCM；奇数字节留到下一段 */
  push(bytes: Uint8Array) {
    if (this.disposed) {
      return
    }
    if (this.context.state === 'suspended') {
      void this.context.resume().catch(() => {})
    }
    const merged = new Uint8Array(this.rest.length + bytes.length)
    merged.set(this.rest)
    merged.set(bytes, this.rest.length)
    const samples = toFloat32(merged)
    this.rest = merged.slice(samples.length * 2)
    if (samples.length === 0) {
      return
    }
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    // 网络慢于播放时从当前时间续上，不补播过去的时间
    this.nextTime = Math.max(
      this.nextTime,
      this.context.currentTime + (this.started ? 0 : START_DELAY)
    )
    source.start(this.nextTime)
    this.nextTime += buffer.duration
    this.started = true
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
    }
  }

  /** 打断：停掉全部已排程音频，重置时间线与残留字节 */
  flush() {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // 已结束的 source 重复 stop 会抛错，忽略
      }
    }
    this.sources.clear()
    this.nextTime = 0
    this.started = false
    this.rest = new Uint8Array(0)
  }

  dispose() {
    this.flush()
    this.disposed = true
    void this.context.close().catch(() => {})
  }
}
