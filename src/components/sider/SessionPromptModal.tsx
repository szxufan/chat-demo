import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setNewChatSystemPrompt, useDrafts } from '../../services/chat/drafts.js'
import { useFolders } from '../../services/chat/folders.js'
import { readSessionSystemPrompt, setSessionSystemPrompt } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './SessionPromptModal.module.css'

/**
 * 会话级系统提示词编辑：勾选「跟随全局/分组设置」清除覆盖，否则保存输入内容（允许为空）。
 * sessionId 为 null 时编辑尚未创建的新对话，覆盖值暂存到草稿服务，首次发送时附加到会话。
 * 会话属于设置了提示词的分组（或新对话目标分组有提示词）时，跟随项展示分组提示词。
 */
export const SessionPromptModal = ({
  sessionId,
  onClose,
}: {
  sessionId: string | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const globalPrompt = useSettings((state) => state.systemPrompt)
  const folders = useFolders((state) => state.folders)
  // null 表示详情尚未加载完成；folderId 用于解析跟随的分组提示词
  const [editor, setEditor] = useState<{
    followGlobal: boolean
    draft: string
    folderId?: string
  } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setEditor(null)
    setLoadFailed(false)
    if (sessionId === null) {
      const pending = useDrafts.getState().newChatSystemPrompt
      const folderId = useFolders.getState().activeFolderId ?? undefined
      const folder = useFolders.getState().folders.find((item) => item.id === folderId)
      setEditor({
        followGlobal: pending === undefined,
        draft: pending ?? folder?.systemPrompt ?? useSettings.getState().systemPrompt,
        folderId,
      })
      return
    }
    void readSessionSystemPrompt(sessionId)
      .then((session) => {
        if (cancelled) {
          return
        }
        if (!session) {
          setLoadFailed(true)
          return
        }
        const folder = useFolders.getState().folders.find((item) => item.id === session.folderId)
        setEditor({
          followGlobal: session.systemPrompt === undefined,
          draft: session.systemPrompt ?? folder?.systemPrompt ?? useSettings.getState().systemPrompt,
          folderId: session.folderId,
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

  const folder = folders.find((item) => item.id === editor?.folderId)
  const inheritedPrompt = folder?.systemPrompt ?? globalPrompt
  const followLabel =
    folder?.systemPrompt !== undefined
      ? t('sessionPromptFollowFolder')
      : t('sessionPromptFollowGlobal')

  const confirm = () => {
    if (!editor) {
      return
    }
    const value = editor.followGlobal ? undefined : editor.draft.trim()
    if (sessionId === null) {
      setNewChatSystemPrompt(value)
    } else {
      setSessionSystemPrompt(sessionId, value)
    }
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
              {followLabel}
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
            {editor.followGlobal && inheritedPrompt ? (
              <div className={styles.globalPreview}>{inheritedPrompt}</div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
