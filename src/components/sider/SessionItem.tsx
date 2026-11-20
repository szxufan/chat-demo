import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SearchSnippet } from '../../services/chat/search.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  snippet,
  onDelete,
  onEditPrompt,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  session: SessionSummary
  active: boolean
  /** 内容搜索命中时展示匹配片段；标题命中无片段 */
  snippet?: SearchSnippet
  onDelete: () => void
  onEditPrompt: () => void
  onMove: () => void
  /** 提供时允许拖拽移动分组；搜索结果列表不启用 */
  onDragStart?: (id: string) => void
  onDragEnd?: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active, snippet && styles.itemWithSnippet)}
      draggable={onDragStart !== undefined}
      onDragStart={
        onDragStart
          ? (event) => {
              event.dataTransfer.setData('text/plain', session.id)
              event.dataTransfer.effectAllowed = 'move'
              onDragStart(session.id)
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.itemText}>
        <div className={styles.title}>{displayTitle}</div>
        {snippet ? (
          <div className={styles.snippet}>
            {snippet.text.slice(0, snippet.start)}
            <mark className={styles.snippetMark}>
              {snippet.text.slice(snippet.start, snippet.end)}
            </mark>
            {snippet.text.slice(snippet.end)}
          </div>
        ) : null}
      </div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'systemPrompt',
              label: t('sessionItemMenuSystemPromptOption'),
              icon: <IconSettingsOutline16 />,
              onSelect: onEditPrompt,
            },
            {
              key: 'move',
              label: t('sessionItemMenuMoveOption'),
              icon: <IconFolderOutline16 />,
              onSelect: onMove,
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
