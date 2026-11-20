import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { setActiveFolder, useFolders } from '../../services/chat/folders.js'
import { IconCloseOutline16, IconFolderOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const targetFolder = useFolders((state) =>
    state.activeFolderId === null
      ? undefined
      : state.folders.find((folder) => folder.id === state.activeFolderId)
  )
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {targetFolder ? (
          <div
            className={styles.folderHint}
            title={t('welcomeFolderHint', { name: targetFolder.name })}
          >
            <span className={styles.folderHintIcon}>
              <IconFolderOutline16 />
            </span>
            <span className={styles.folderHintName}>{targetFolder.name}</span>
            <IconButton
              size="xs"
              icon={<IconCloseOutline16 />}
              aria-label={t('welcomeFolderHintCancel')}
              onClick={() => setActiveFolder(null)}
            />
          </div>
        ) : null}
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
