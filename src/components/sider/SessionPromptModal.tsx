import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { readSessionSystemPrompt, setSessionSystemPrompt } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './SessionPromptModal.module.css'

/** 会话级系统提示词编辑：勾选「跟随全局设置」清除覆盖，否则保存输入内容（允许为空）。 */
export const SessionPromptModal = ({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const globalPrompt = useSettings((state) => state.systemPrompt)
  // null 表示详情尚未加载完成
  const [editor, setEditor] = useState<{ followGlobal: boolean; draft: string } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setEditor(null)
    setLoadFailed(false)
    void readSessionSystemPrompt(sessionId)
      .then((session) => {
        if (cancelled) {
          return
        }
        if (!session) {
          setLoadFailed(true)
          return
        }
        setEditor({
          followGlobal: session.systemPrompt === undefined,
          draft: session.systemPrompt ?? useSettings.getState().systemPrompt,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const confirm = () => {
    if (!editor) {
      return
    }
    setSessionSystemPrompt(sessionId, editor.followGlobal ? undefined : editor.draft.trim())
    onClose()
  }

  return (
    <Modal
      title={t('sessionPromptModalTitle')}
      closable
      className={styles.dialog}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" autoFocus onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={!editor} onClick={confirm}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {loadFailed ? (
          <div className={styles.description} role="alert">
            {t('sessionLoadFailed')}
          </div>
        ) : editor ? (
          <>
            <div className={styles.description}>{t('sessionPromptDescription')}</div>
            <label className={styles.followGlobal}>
              <input
                type="checkbox"
                checked={editor.followGlobal}
                autoFocus={editor.followGlobal}
                onChange={(event) =>
                  setEditor((prev) => prev && { ...prev, followGlobal: event.target.checked })
                }
              />
              {t('sessionPromptFollowGlobal')}
            </label>
            {!editor.followGlobal ? (
              <textarea
                className={styles.input}
                aria-label={t('sessionPromptModalTitle')}
                placeholder={t('sessionPromptPlaceholder')}
                rows={5}
                spellCheck={false}
                autoFocus
                value={editor.draft}
                onChange={(event) => setEditor({ ...editor, draft: event.target.value })}
              />
            ) : null}
            {editor.followGlobal && globalPrompt ? (
              <div className={styles.globalPreview}>{globalPrompt}</div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
