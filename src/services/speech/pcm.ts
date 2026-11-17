/** 16-bit 小端 PCM 与 base64 的共用工具：朗读与实时语音共用。 */

/** 16-bit 小端 PCM 转成 Float32；奇数字节由调用方留到下一段 */
export const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

/** base64 → 字节（服务端音频增量） */
export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 字节 → base64（客户端音频增量）；分块拼接避免超出函数参数上限 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
