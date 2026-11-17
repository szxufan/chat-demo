import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AssistantMessage, McpMedia } from '../../services/chat/types.js'
import type { McpToolStep } from '../../services/chat/view.js'
import {
  IconAppsFill16,
  IconPhotoOutline16,
  IconSearchWarningOutline16,
  IconVideoOutline16,
} from '../base/icons.js'
import { useFileUrl } from './useFileUrl.js'
import { useTicker } from './useTicker.js'
import areaStyles from './ReplyArea.module.css'
import styles from './McpToolRow.module.css'

const isVideoTool = (name: string) => name.startsWith('generate_video') || name === 'get_video_task'

/** 结果消息为 JSON：失败展示优先取 error，其次 text */
const readErrorText = (message: string): string => {
  try {
    const value: unknown = JSON.parse(message)
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.error === 'string') {
        return record.error
      }
      if (typeof record.text === 'string') {
        return record.text
      }
    }
  } catch {
    // 非 JSON 直接展示原文
  }
  return message
}

/** 单个生成媒体：图片缩略图链接原件；视频内联播放，混合内容受限时降级为新标签链接 */
const MediaItem = ({ media }: { media: McpMedia }) => {
  const t = useTranslate()
  const localUrl = useFileUrl(media.fileId ?? '')
  const url = media.fileId ? (localUrl ?? (media.url || null)) : media.url || null
  if (media.kind === 'image') {
    if (!url) {
      return <span className={styles.missing}>{t('mcpMediaMissing')}</span>
    }
    return (
      <a
        className={styles.imageLink}
        href={url}
        target="_blank"
        rel="noreferrer"
        title={media.name}
      >
        <img className={styles.image} src={url} alt={media.name} />
      </a>
    )
  }
  const playable =
    url !== null &&
    (url.startsWith('blob:') || url.startsWith('https:') || window.location.protocol === 'http:')
  if (playable && url) {
    return <video className={styles.video} src={url} controls preload="metadata" />
  }
  if (url) {
    return (
      <a className={styles.videoLink} href={url} target="_blank" rel="noreferrer">
        {t('mcpVideoOpen')}
      </a>
    )
  }
  return <span className={styles.missing}>{t('mcpMediaMissing')}</span>
}

/** MCP 工具行：进行态显示进度与耗时，完成态展示生成的图片/视频，失败态展示错误 */
export const McpToolRow = ({
  step,
  message,
  streaming,
  isLast,
}: {
  step: McpToolStep
  message: AssistantMessage
  streaming: boolean
  isLast: boolean
}) => {
  const t = useTranslate()
  const wip = step.status === 'wip'
  useTicker(wip, 1000)
  const video = isVideoTool(step.name)
  const image = step.name === 'generate_image'
  const icon =
    step.status === 'failed' ? (
      <IconSearchWarningOutline16 />
    ) : video ? (
      <IconVideoOutline16 />
    ) : image ? (
      <IconPhotoOutline16 />
    ) : (
      <IconAppsFill16 />
    )
  const seconds =
    wip && step.startedAt !== undefined
      ? Math.max(1, Math.round((Date.now() - step.startedAt) / 1000))
      : null
  const stopped =
    step.status === 'failed' && !streaming && message.status === 'stopped' && !step.message

  let body: ReactNode
  if (wip) {
    body = (
      <>
        <span className={clsx(styles.label, areaStyles.shimmer)}>
          {t(video ? 'mcpVideoGenerating' : image ? 'mcpImageGenerating' : 'mcpToolRunning')}
        </span>
        {step.progress ? <span className={styles.progress}>{step.progress}</span> : null}
        {seconds !== null ? (
          <span className={styles.elapsed}>{t('mcpToolDuration', { count: seconds })}</span>
        ) : null}
      </>
    )
  } else if (stopped) {
    body = <span>{t('mcpToolStopped')}</span>
  } else if (step.status === 'failed') {
    const detail = readErrorText(step.message)
    body = (
      <>
        <span>{t('mcpToolFailed')}</span>
        {detail ? <span className={styles.error}>{detail.slice(0, 300)}</span> : null}
      </>
    )
  } else {
    body = (
      <>
        <span className={styles.label}>
          {video ? t('mcpVideoDone') : image ? t('mcpImageDone') : step.name}
        </span>
        {step.media.length > 0 ? (
          <div className={styles.media}>
            {step.media.map((item, index) => (
              <MediaItem key={item.fileId ?? (item.url || null) ?? index} media={item} />
            ))}
          </div>
        ) : null}
      </>
    )
  }
  return (
    <div className={clsx(areaStyles.tool, !isLast && areaStyles.withLine)}>
      <span className={clsx(areaStyles.rowIcon, areaStyles.toolIcon)}>{icon}</span>
      <div className={areaStyles.toolBody}>{body}</div>
    </div>
  )
}
