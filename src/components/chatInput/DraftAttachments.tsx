import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { IconCloseFill14 } from '../base/icons.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ChatInput.module.css'

/** 列表只随草稿附件变化更新；附件只存本地，发送时内联，没有上传状态。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRemove,
}: {
  items: DraftAttachment[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.attachments}>
      {items.map((item) => (
        <AttachmentItem key={item.id} item={item} onRemove={() => onRemove(item.id)} />
      ))}
    </div>
  )
})

/** 输入框里的附件：图片显示缩略图，其余显示文件卡片 */
const AttachmentItem = ({
  item,
  onRemove,
}: {
  item: DraftAttachment
  onRemove: () => void
}) => {
  const t = useTranslate()
  return item.previewUrl ? (
    <div className={styles.attachment} title={item.file.name}>
      <img src={item.previewUrl} alt={item.file.name} />
      <button
        type="button"
        className={styles.remove}
        aria-label={t('delete')}
        onClick={onRemove}
      >
        <IconCloseFill14 />
      </button>
    </div>
  ) : (
    <FileCard name={item.file.name} size={item.file.size} onRemove={onRemove} />
  )
}
