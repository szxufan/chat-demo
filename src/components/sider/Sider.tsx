import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { searchSessions, type SessionSearchResult } from '../../services/chat/search.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { SessionPromptModal } from './SessionPromptModal.js'
import { consumeSiderSearchFocus, useSiderSearchFocus } from './siderSearchState.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、搜索、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [promptEditing, setPromptEditing] = useState<SessionSummary | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchFocusPending = useSiderSearchFocus((state) => state.pending)
  const searching = query.trim() !== ''

  // 只处理收起态搜索按钮发起的聚焦请求，正常展开时不抢焦点。
  useEffect(() => {
    if (searchFocusPending && consumeSiderSearchFocus()) {
      searchRef.current?.focus()
    }
  }, [searchFocusPending])

  // 防抖搜索；会话列表变化（删除、重命名）时同步刷新结果。
  useEffect(() => {
    if (!searching) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void searchSessions(query).then((matches) => {
        if (!cancelled) {
          setResults(matches)
        }
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, searching, sessions])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.searchRow}>
        <span className={styles.searchIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          ref={searchRef}
          className={styles.searchInput}
          type="text"
          role="searchbox"
          value={query}
          placeholder={t('sessionSearchPlaceholder')}
          aria-label={t('sessionSearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && query) {
              event.stopPropagation()
              setQuery('')
            }
          }}
        />
        {query ? (
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            aria-label={t('sessionSearchClear')}
            onClick={() => {
              setQuery('')
              searchRef.current?.focus()
            }}
          />
        ) : null}
      </div>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {searching ? (
            results === null ? null : results.length === 0 ? (
              <div className={styles.searchEmpty}>{t('sessionSearchNoMatch')}</div>
            ) : (
              results.map((result) => (
                <SessionItem
                  key={result.session.id}
                  session={result.session}
                  active={result.session.id === activeId}
                  snippet={result.snippet}
                  onDelete={() => setDeleting(result.session)}
                  onEditPrompt={() => setPromptEditing(result.session)}
                />
              ))
            )
          ) : (
            groups.map((group) => (
              <div key={group.key} className={styles.section}>
                <div className={styles.sectionHeader}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onDelete={() => setDeleting(session)}
                    onEditPrompt={() => setPromptEditing(session)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {promptEditing ? (
        <SessionPromptModal sessionId={promptEditing.id} onClose={() => setPromptEditing(null)} />
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
