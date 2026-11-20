import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconFolderPlusOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { updateFolder, useFolders } from '../../services/chat/folders.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { searchSessions, type SessionSearchResult } from '../../services/chat/search.js'
import {
  moveSessionToFolder,
  newChat,
  newChatInFolder,
  removeFolder,
  removeSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { Folder, SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { FolderSettingsModal } from './FolderSettingsModal.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { MoveToFolderModal } from './MoveToFolderModal.js'
import { SessionItem } from './SessionItem.js'
import { SessionPromptModal } from './SessionPromptModal.js'
import { consumeSiderSearchFocus, useSiderSearchFocus } from './siderSearchState.js'
import styles from './Sider.module.css'

/** 拖拽移出分组的放置区标识；分组 id 由 createId 生成，不会与之冲突 */
const UNGROUPED_DROP = 'ungrouped'

/** 展开的侧边栏：名称与收起按钮、开启新对话、搜索、分组与按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const folders = useFolders((state) => state.folders)
  const [now, setNow] = useState(Date.now)
  // 归属已删除分组的会话按未分组展示，避免悬空引用导致会话消失。
  const folderSections = useMemo(
    () =>
      folders.map((folder) => ({
        folder,
        sessions: sessions.filter((session) => session.folderId === folder.id),
      })),
    [folders, sessions]
  )
  const ungrouped = useMemo(() => {
    const ids = new Set(folders.map((folder) => folder.id))
    return sessions.filter((session) => !session.folderId || !ids.has(session.folderId))
  }, [sessions, folders])
  const groups = useMemo(() => groupSessions(ungrouped, now, t), [ungrouped, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [promptEditing, setPromptEditing] = useState<SessionSummary | null>(null)
  const [moving, setMoving] = useState<SessionSummary | null>(null)
  /** null 表示新建分组 */
  const [folderSettings, setFolderSettings] = useState<{ id: string | null } | null>(null)
  const [folderDeleting, setFolderDeleting] = useState<Folder | null>(null)
  const [folderDeletePending, setFolderDeletePending] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchFocusPending = useSiderSearchFocus((state) => state.pending)
  const searching = query.trim() !== ''

  const handleDragStart = useCallback((id: string) => setDraggingId(id), [])
  const handleDragEnd = useCallback(() => {
    setDraggingId(null)
    setDropTarget(null)
  }, [])
  const handleDrop = (folderId: string | null) => {
    if (draggingId) {
      moveSessionToFolder(draggingId, folderId)
    }
    setDraggingId(null)
    setDropTarget(null)
  }
  const dropProps = (target: string, folderId: string | null) =>
    draggingId
      ? {
          onDragOver: (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget(target)
          },
          onDragLeave: (event: DragEvent<HTMLDivElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget((current) => (current === target ? null : current))
            }
          },
          onDrop: (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault()
            handleDrop(folderId)
          },
        }
      : {}

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
      <div className={styles.newChatRow}>
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
        <IconButton
          size="m"
          icon={<IconFolderPlusOutline16 />}
          tooltip={t('newFolderButton')}
          tooltipPlacement="bottom"
          onClick={() => setFolderSettings({ id: null })}
        />
      </div>
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
                  onMove={() => setMoving(result.session)}
                />
              ))
            )
          ) : (
            <>
              {folderSections.map(({ folder, sessions: folderSessions }) => (
                <div key={folder.id} className={styles.section}>
                  <div
                    className={clsx(
                      styles.folderHeader,
                      dropTarget === folder.id && styles.dropTarget
                    )}
                    role="button"
                    tabIndex={0}
                    aria-expanded={!folder.collapsed}
                    onClick={() => updateFolder(folder.id, { collapsed: !folder.collapsed })}
                    onKeyDown={(event) => {
                      // 只处理头部自身的按键，忽略内部按钮冒泡上来的 Enter / Space。
                      if (event.target !== event.currentTarget) {
                        return
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        updateFolder(folder.id, { collapsed: !folder.collapsed })
                      }
                    }}
                    {...dropProps(folder.id, folder.id)}
                  >
                    <span className={styles.folderChevron}>
                      {folder.collapsed ? (
                        <IconChevronRightOutline14 />
                      ) : (
                        <IconChevronDownOutline14 />
                      )}
                    </span>
                    <span className={styles.folderIcon}>
                      <IconFolderOutline16 />
                    </span>
                    <span className={styles.folderName}>{folder.name}</span>
                    <span
                      className={styles.folderCount}
                      aria-label={t('folderSessionCount', { count: folderSessions.length })}
                    >
                      {folderSessions.length}
                    </span>
                    <span
                      className={styles.folderActions}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <IconButton
                        size="xs"
                        icon={<NewChatIcon />}
                        tooltip={t('folderMenuNewChatOption')}
                        onClick={() => {
                          newChatInFolder(folder.id)
                          closeMobileSider()
                        }}
                      />
                      <Menu
                        options={[
                          {
                            key: 'edit',
                            label: t('folderMenuEditOption'),
                            icon: <IconEditOutline16 />,
                            onSelect: () => setFolderSettings({ id: folder.id }),
                          },
                          {
                            key: 'newChat',
                            label: t('folderMenuNewChatOption'),
                            icon: <NewChatIcon />,
                            onSelect: () => {
                              newChatInFolder(folder.id)
                              closeMobileSider()
                            },
                          },
                          {
                            key: 'delete',
                            label: t('folderMenuDeleteOption'),
                            icon: <IconTrashOutline16 />,
                            danger: true,
                            onSelect: () => setFolderDeleting(folder),
                          },
                        ]}
                      >
                        {({ toggle }) => (
                          <IconButton
                            icon={<IconEllipsisOutline16 />}
                            aria-label={t('more')}
                            onClick={toggle}
                          />
                        )}
                      </Menu>
                    </span>
                  </div>
                  {!folder.collapsed ? (
                    folderSessions.length === 0 ? (
                      <div className={styles.folderEmpty}>{t('folderEmpty')}</div>
                    ) : (
                      folderSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          active={session.id === activeId}
                          onDelete={() => setDeleting(session)}
                          onEditPrompt={() => setPromptEditing(session)}
                          onMove={() => setMoving(session)}
                          onDragStart={mobile ? undefined : handleDragStart}
                          onDragEnd={mobile ? undefined : handleDragEnd}
                        />
                      ))
                    )
                  ) : null}
                </div>
              ))}
              <div
                className={clsx(
                  styles.ungroupedArea,
                  folderSections.length > 0 && styles.withFolders,
                  draggingId && styles.ungroupedDragging,
                  dropTarget === UNGROUPED_DROP && styles.dropTarget
                )}
                {...dropProps(UNGROUPED_DROP, null)}
              >
                {draggingId && ungrouped.length === 0 ? (
                  <div className={styles.ungroupedHint}>{t('moveToFolderUngrouped')}</div>
                ) : null}
                {groups.map((group) => (
                  <div key={group.key} className={styles.section}>
                    <div className={styles.sectionHeader}>{group.label}</div>
                    {group.sessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        onDelete={() => setDeleting(session)}
                        onEditPrompt={() => setPromptEditing(session)}
                        onMove={() => setMoving(session)}
                        onDragStart={mobile ? undefined : handleDragStart}
                        onDragEnd={mobile ? undefined : handleDragEnd}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
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
      {folderDeleting ? (
        <Modal
          title={t('deleteFolderModalTitle')}
          onClose={() => {
            if (!folderDeletePending) {
              setFolderDeleting(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={folderDeletePending}
                onClick={() => setFolderDeleting(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={folderDeletePending}
                onClick={async () => {
                  setFolderDeletePending(true)
                  try {
                    if (await removeFolder(folderDeleting.id)) {
                      setFolderDeleting(null)
                    } else {
                      showToast({ key: 'folderDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setFolderDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteFolderDescription')}
        </Modal>
      ) : null}
      {promptEditing ? (
        <SessionPromptModal sessionId={promptEditing.id} onClose={() => setPromptEditing(null)} />
      ) : null}
      {moving ? (
        <MoveToFolderModal
          sessionId={moving.id}
          onClose={() => setMoving(null)}
          onCreateFolder={() => {
            setMoving(null)
            setFolderSettings({ id: null })
          }}
        />
      ) : null}
      {folderSettings ? (
        <FolderSettingsModal
          folderId={folderSettings.id}
          onClose={() => setFolderSettings(null)}
        />
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
