import * as db from '../db.js'
import type { Folder, Session } from '../types.js'
import {
  EXPORT_FORMAT_VERSION,
  type FolderFile,
  type Manifest,
  type SessionIndexEntry,
} from './format.js'
import { FOLDERS_PATH, INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 按导出格式生成 ZIP：manifest → folders → 全部会话 JSON → index → 全部图片。没有账号信息，不写 user.json。
 * 只写出本地有原件的图片，每个会话目录各写一份；其他附件只有元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  folders: Folder[]
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const folderFiles: FolderFile[] = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    ...(folder.systemPrompt !== undefined ? { system_prompt: folder.systemPrompt } : {}),
  }))
  const entries = [
    { name: MANIFEST_PATH, blob: json(manifest) },
    { name: FOLDERS_PATH, blob: json(folderFiles) },
  ]
  const imageEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (file.isImage && !originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      }
    }
    const images = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name, isImage }) => {
      const blob = originals.get(id)
      if (!blob || !isImage) {
        return null
      }
      const path = imagePath(session.id, id, name)
      images.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of images) {
      imageEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(imageEntries))
}
