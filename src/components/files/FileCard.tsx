import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension } from '../../services/attachments.js'
import { IconCloseFill14 } from '../base/icons.js'
import { FileIcon } from './FileIcon.js'
import styles from './FileCard.module.css'

/**
 * 文件卡片：图标 + 文件名 + 「扩展名 大小」。
 * 附件只存本地、发送时内联，没有上传状态；历史遗留的非图片附件用此卡片展示。
 */
export const FileCard = ({
  name,
  size,
  onRemove,
  onOpen,
}: {
  name: string
  size: number
  onRemove?: () => void
  onOpen?: () => void
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  const description = [ext, formatSize(size)].filter(Boolean).join(' ')
  return (
    <div
      className={clsx(styles.card, onRemove && styles.editable, onOpen && styles.clickable)}
      title={name}
      onClick={onOpen}
    >
      <div className={styles.icon}>
        <FileIcon ext={ext} />
      </div>
      <div className={styles.content}>
        <div className={styles.caption}>{name}</div>
        <div className={styles.subCaption}>{description}</div>
      </div>
      {onRemove ? (
        <button
          type="button"
          className={styles.remove}
          aria-label={t('delete')}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}
