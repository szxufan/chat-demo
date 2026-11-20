import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { createFolder, updateFolder, useFolders } from '../../services/chat/folders.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import promptStyles from './SessionPromptModal.module.css'
import styles from './FolderSettingsModal.module.css'

/**
 * 新建分组 / 分组设置：名称 + 分组系统提示词。
 * 提示词语义与会话一致：勾选「跟随全局设置」清除覆盖，否则保存输入内容（允许为空）。
 */
export const FolderSettingsModal = ({
  folderId,
  onClose,
}: {
  /** null 表示新建分组 */
  folderId: string | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const globalPrompt = useSettings((state) => state.systemPrompt)
  const folder = useFolders((state) =>
    folderId === null ? undefined : state.folders.find((item) => item.id === folderId)
  )
  const [name, setName] = useState(folder?.name ?? '')
  const [followGlobal, setFollowGlobal] = useState(folder?.systemPrompt === undefined)
  const [draft, setDraft] = useState(folder?.systemPrompt ?? globalPrompt)

  const confirm = () => {
    const trimmed = name.trim()
    if (!trimmed || (folderId !== null && !folder)) {
      return
    }
    const prompt = followGlobal ? undefined : draft.trim()
    if (folderId === null) {
      createFolder(trimmed, prompt)
    } else {
      updateFolder(folderId, { name: trimmed, systemPrompt: prompt })
    }
    onClose()
  }

  return (
    <Modal
      title={folderId === null ? t('folderSettingsCreateTitle') : t('folderSettingsEditTitle')}
      closable
      className={promptStyles.dialog}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={confirm}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className={promptStyles.body}>
        <label className={styles.nameRow}>
          <span className={styles.nameLabel}>{t('folderNameLabel')}</span>
          <input
            className={styles.nameInput}
            type="text"
            value={name}
            placeholder={t('folderNamePlaceholder')}
            autoFocus
            onFocus={(event) => event.target.select()}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                confirm()
              }
            }}
          />
        </label>
        <div className={promptStyles.description}>{t('folderPromptDescription')}</div>
        <label className={promptStyles.followGlobal}>
          <input
            type="checkbox"
            checked={followGlobal}
            onChange={(event) => setFollowGlobal(event.target.checked)}
          />
          {t('sessionPromptFollowGlobal')}
        </label>
        {!followGlobal ? (
          <textarea
            className={promptStyles.input}
            aria-label={t('sessionItemMenuSystemPromptOption')}
            placeholder={t('sessionPromptPlaceholder')}
            rows={5}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : null}
        {followGlobal && globalPrompt ? (
          <div className={promptStyles.globalPreview}>{globalPrompt}</div>
        ) : null}
      </div>
    </Modal>
  )
}
