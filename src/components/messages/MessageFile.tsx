import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { loadFile } from '../../services/chat/db.js'
import type { FileAttachment } from '../../services/chat/types.js'
import { IconPhotoErrorFill20 } from '../base/icons.js'
import { FileCard } from '../files/FileCard.js'
import styles from './MessageFile.module.css'

/** 原件从 IndexedDB 读出并生成本地地址；undefined 表示加载中，null 表示原件缺失。 */
const useFileUrl = (id: string) => {
  const [fileUrl, setFileUrl] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    loadFile(id).then((blob) => {
      if (!cancelled) {
        objectUrl = blob ? URL.createObjectURL(blob) : null
        setFileUrl({ id, url: objectUrl })
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [id])
  return fileUrl?.id === id ? fileUrl.url : undefined
}

/**
 * 消息里的附件：图片显示缩略图并链接到本地原件；
 * 历史遗留的非图片附件只有元数据或原件，显示文件卡片。
 */
export const MessageFile = ({ file }: { file: FileAttachment }) => {
  const url = useFileUrl(file.id)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  if (file.isImage && url !== null) {
    const preview = url ? (
      failedUrl === url ? (
        <span className={styles.failedIcon} role="img" aria-label={file.name}>
          <IconPhotoErrorFill20 />
        </span>
      ) : (
        <img src={url} alt={file.name} onError={() => setFailedUrl(url)} />
      )
    ) : null

    return url ? (
      <a
        className={clsx(styles.image, styles.imageThumb)}
        href={url}
        target="_blank"
        rel="noreferrer"
        title={file.name}
      >
        {preview}
      </a>
    ) : (
      // 原件还没加载出来（极短暂）
      <div className={styles.image} />
    )
  }

  return (
    <FileCard
      name={file.name}
      size={file.size}
      onOpen={url ? () => window.open(url, '_blank', 'noreferrer') : undefined}
    />
  )
}
