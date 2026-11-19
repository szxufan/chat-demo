import { readImageDataUrl } from '../attachments.js'

/**
 * 实时通话图片转码：百炼 Realtime 的 input_image_buffer.append 只收 JPEG，
 * base64 后不得超过 256KB（原始建议 ≤190KB），分辨率建议 480P/720P、最高 1080P。
 * 历史里仍保留本地原件，这里只压缩发给模型的副本。
 */

/** 原始大小上限：base64 约膨胀 4/3，留出服务端 256KB 限制的余量 */
const MAX_JPEG_BYTES = 190 * 1024
/** 质量递减档位；全部超限则降分辨率重试 */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4]
/** 最长边档位：720P 推荐分辨率起步，压不下再降 */
const DIMENSION_STEPS = [1280, 960, 640]

const canvasToJpeg = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))),
      'image/jpeg',
      quality
    )
  })

/** 把附件图片转成符合 Realtime 限制的 JPEG base64（无 data: 前缀）；失败抛错由调用方提示 */
export const toRealtimeJpeg = async (blob: Blob): Promise<string> => {
  const bitmap = await createImageBitmap(blob)
  try {
    for (const maxSide of DIMENSION_STEPS) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('canvas 2d context unavailable')
      }
      // JPEG 无透明通道，铺白底避免透明区域变黑
      context.fillStyle = '#fff'
      context.fillRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
      for (const quality of QUALITY_STEPS) {
        const jpeg = await canvasToJpeg(canvas, quality)
        if (jpeg.size <= MAX_JPEG_BYTES) {
          const dataUrl = await readImageDataUrl(jpeg)
          return dataUrl.slice(dataUrl.indexOf(',') + 1)
        }
      }
    }
    throw new Error('image cannot be compressed under the realtime size limit')
  } finally {
    bitmap.close()
  }
}
