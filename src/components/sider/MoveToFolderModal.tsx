import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useFolders } from '../../services/chat/folders.js'
import { moveSessionToFolder, useChatStore } from '../../services/chat/store.js'
import { IconCheckOutline16, IconFolderOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import promptStyles from './SessionPromptModal.module.css'
import styles from './MoveToFolderModal.module.css'

/** 移动会话到分组：单选列表（未分组 + 各分组）；没有分组时引导新建。 */
export const MoveToFolderModal = ({
  sessionId,
  onClose,
  onCreateFolder,
}: {
  sessionId: string
  onClose: () => void
  onCreateFolder: () => void
}) => {
  const t = useTranslate()
  const folders = useFolders((state) => state.folders)
  const currentFolderId = useChatStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.folderId ?? null
  )
  const [selected, setSelected] = useState<string | null>(currentFolderId)

  const confirm = () => {
    moveSessionToFolder(sessionId, selected)
    onClose()
  }

  const option = (id: string | null, label: string, icon?: ReactNode) => (
    <button
      key={id ?? 'ungrouped'}
      type="button"
      role="radio"
      aria-checked={selected === id}
      className={clsx(styles.option, selected === id && styles.optionSelected)}
      onClick={() => setSelected(id)}
    >
      {icon ? <span className={styles.optionIcon}>{icon}</span> : null}
      <span className={styles.optionLabel}>{label}</span>
      {selected === id ? (
        <span className={styles.optionCheck}>
          <IconCheckOutline16 />
        </span>
      ) : null}
    </button>
  )

  return (
    <Modal
      title={t('moveToFolderTitle')}
      closable
      className={promptStyles.dialog}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={confirm}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className={promptStyles.body}>
        {folders.length === 0 ? (
          <>
            <div className={promptStyles.description}>{t('moveToFolderEmpty')}</div>
            <Button variant="outlined" onClick={onCreateFolder}>
              {t('newFolderButton')}
            </Button>
          </>
        ) : (
          <div className={styles.options} role="radiogroup" aria-label={t('moveToFolderTitle')}>
            {option(null, t('moveToFolderUngrouped'))}
            {folders.map((folder) =>
              option(folder.id, folder.name, <IconFolderOutline16 />)
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
