import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { useSettings } from '../settings.js'
import * as db from './db.js'
import type { Folder } from './types.js'

type FolderState = {
  /** 按名称排序，侧边栏按此顺序渲染。 */
  folders: Folder[]
  /** 新对话的目标分组；null 表示不分组。仅在欢迎页（activeId 为 null）有意义。 */
  activeFolderId: string | null
}

export const useFolders = create<FolderState>(() => ({
  folders: [],
  activeFolderId: null,
}))

const sortFolders = (folders: Folder[]) =>
  [...folders].sort((a, b) => a.name.localeCompare(b.name))

export const getFolder = (id: string | undefined): Folder | undefined =>
  id === undefined ? undefined : useFolders.getState().folders.find((folder) => folder.id === id)

/** 整体替换分组列表（初始化、历史替换后调用），并清除新对话目标。 */
export const resetFolders = (folders: Folder[]) =>
  useFolders.setState({ folders: sortFolders(folders), activeFolderId: null })

export const setActiveFolder = (id: string | null) => useFolders.setState({ activeFolderId: id })

export const createFolder = (name: string, systemPrompt?: string): Folder => {
  const now = Date.now()
  const folder: Folder = {
    id: createId(),
    name,
    createdAt: now,
    updatedAt: now,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  }
  useFolders.setState((state) => ({ folders: sortFolders([...state.folders, folder]) }))
  void db.saveFolder(folder).catch(db.reportStorageError('save folder'))
  return folder
}

/** 更新分组名称、提示词或折叠状态；systemPrompt 显式传 undefined 表示清除覆盖。 */
export const updateFolder = (
  id: string,
  patch: { name?: string; systemPrompt?: string; collapsed?: boolean }
) => {
  const state = useFolders.getState()
  const previous = state.folders.find((folder) => folder.id === id)
  if (!previous) {
    return
  }
  const next: Folder = { ...previous, ...patch }
  if ('systemPrompt' in patch && patch.systemPrompt === undefined) {
    delete next.systemPrompt
  }
  if (patch.name !== undefined || 'systemPrompt' in patch) {
    next.updatedAt = Date.now()
  }
  useFolders.setState({
    folders: sortFolders(state.folders.map((folder) => (folder.id === id ? next : folder))),
  })
  void db.saveFolder(next).catch(db.reportStorageError('save folder'))
}

/** 仅同步内存；数据库级联删除（含组内会话移回未分组）由 store.removeFolder 完成。 */
export const forgetFolder = (id: string) =>
  useFolders.setState((state) => ({
    folders: state.folders.filter((folder) => folder.id !== id),
    activeFolderId: state.activeFolderId === id ? null : state.activeFolderId,
  }))

/** 提示词优先级：会话覆盖 > 分组提示词 > 全局设置；空字符串表示不使用系统提示词。 */
export const resolveSystemPrompt = (
  session?: { systemPrompt?: string; folderId?: string }
): string =>
  session?.systemPrompt ??
  getFolder(session?.folderId)?.systemPrompt ??
  useSettings.getState().systemPrompt
