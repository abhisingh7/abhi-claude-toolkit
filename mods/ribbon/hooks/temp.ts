import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Purge, TempFile, TempScan } from '../types'

// Temp files this session left on disk: everything under the session's own temp
// folder (/tmp/claude-<uid>/<project>/<session id>/: the scratchpad, pasted
// images, background task output), plus any new file the Write tool created in a
// system temp folder (/tmp, /var/folders). The band warns with their count and
// size; the open card lists them, each with a delete button, and Delete all
// clears them after one confirm. Folders are left in place: only files go.

export const temp = atom({ plugin: 'ribbon', key: 'temp' } as const, null as TempScan | null)
export const tracked = atom({ plugin: 'ribbon', key: 'tracked' } as const, [] as string[])
export const purge = atom({ plugin: 'ribbon', key: 'purge' } as const, null as Purge | null)

/** How long Delete all waits for its confirm before it reads plainly again. */
export const PURGE_WINDOW_MS = 20_000
/** Rows the open list draws; the rest are summed in one "+N more" row. */
export const LIST_MAX = 15

const SCAN_MAX = 500
const DEPTH_MAX = 8
const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

/** /private/tmp and /tmp are one folder on macOS: compare paths without the prefix. */
const norm = (p: string): string => p.replace(/^\/private\//, '/')

export const isTempPath = (p: string): boolean => TEMP_ROOTS.some(r => p.startsWith(r))

// Found once per module load; not cached while missing, as the engine makes it lazily.
let sessionDir: string | null = null

export async function findSessionDir($: EngineInterface): Promise<string | null> {
  if (sessionDir) return sessionDir
  const id = await $.session.id()
  for (const base of ['/private/tmp', '/tmp']) {
    let tops
    try {
      tops = await $.fs.list(base)
    } catch {
      continue
    }
    for (const t of tops) {
      if (t.kind !== 'dir' || !t.name.startsWith('claude-')) continue
      const root = `${base}/${t.name}`
      let projects
      try {
        projects = await $.fs.list(root)
      } catch {
        continue
      }
      for (const p of projects) {
        if (p.kind !== 'dir') continue
        const dir = `${root}/${p.name}/${id}`
        if (await $.fs.exists(dir)) {
          sessionDir = dir
          return dir
        }
      }
    }
  }
  return null
}

async function walk($: EngineInterface, dir: string, out: TempFile[], depth: number): Promise<void> {
  if (depth > DEPTH_MAX || out.length >= SCAN_MAX) return
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const x of entries) {
    if (out.length >= SCAN_MAX) return
    const path = `${dir}/${x.name}`
    if (x.kind === 'dir' && !x.isLink) await walk($, path, out, depth + 1)
    else if (x.kind === 'file' || x.isLink) out.push({ path, size: x.size, mtimeMs: x.mtimeMs })
  }
}

/** Looks at disk again and stores what this session's temp files are now. */
export async function scanTemp($: EngineInterface): Promise<TempScan> {
  const files: TempFile[] = []
  const dir = await findSessionDir($)
  if (dir) await walk($, dir, files, 0)

  // Temp files Write made outside the session folder: keep those still on disk.
  const seen = new Set(files.map(f => norm(f.path)))
  const keep: string[] = []
  for (const path of await read($, tracked)) {
    if (seen.has(norm(path))) continue
    try {
      const s = await $.fs.stat(path)
      if (s.kind !== 'file') continue
      files.push({ path, size: s.size, mtimeMs: s.mtimeMs })
      seen.add(norm(path))
      keep.push(path)
    } catch {
      // gone: dropped from the list
    }
  }
  await update($, tracked, () => keep)

  files.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)
  const scan: TempScan = { files, total: files.reduce((n, f) => n + f.size, 0), at: await $.clock.now() }
  await update($, temp, () => scan)
  return scan
}

/** Remembers a temp file the Write tool created, so the list can offer it too. */
export async function track($: EngineInterface, path: string): Promise<void> {
  const dir = await findSessionDir($)
  if (dir && norm(path).startsWith(`${norm(dir)}/`)) return // the scan finds it already
  await update($, tracked, list => (list.includes(path) ? list : [...list, path]))
}

let busy = false

async function remove($: EngineInterface, paths: readonly string[]): Promise<string | null> {
  for (let i = 0; i < paths.length; i += 200) {
    const r = await $.process.run(['rm', '-f', '--', ...paths.slice(i, i + 200)])
    if (r.exitCode !== 0) return r.stderr.trim() || `rm exited ${r.exitCode}`
  }
  return null
}

/** Deletes one listed file. Only a path in the last scan is ever deleted. */
export async function deleteOne($: EngineInterface, path: string): Promise<void> {
  if (busy) return
  busy = true
  try {
    const scan = await read($, temp)
    const f = scan?.files.find(x => x.path === path)
    if (!f) return
    const err = await remove($, [f.path])
    $.ui.toast(err ? `Could not delete ${baseName(f.path)}: ${err}` : `Deleted ${baseName(f.path)} (${fmtBytes(f.size)})`)
  } finally {
    await scanTemp($).catch(() => undefined)
    busy = false
  }
}

/** Deletes every listed file; the band asks once before this runs. */
export async function deleteAll($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    await update($, purge, () => null)
    const scan = await read($, temp)
    if (!scan || scan.files.length === 0) return
    const err = await remove($, scan.files.map(f => f.path))
    $.ui.toast(
      err
        ? `Some temp files could not be deleted: ${err}`
        : `Deleted ${scan.files.length} temp file${scan.files.length === 1 ? '' : 's'} (${fmtBytes(scan.total)})`,
    )
  } finally {
    await scanTemp($).catch(() => undefined)
    busy = false
  }
}

export async function askPurge($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, purge, (): Purge => ({ at }))
}

export async function cancelPurge($: EngineInterface): Promise<void> {
  await update($, purge, () => null)
}

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

/** Where a file sits: its folder inside the session's temp folder, or its full folder. */
export const folderOf = (p: string, dir: string | null, home: string | null): string => {
  const parent = p.slice(0, p.lastIndexOf('/'))
  if (dir && norm(p).startsWith(`${norm(dir)}/`)) {
    const rel = norm(parent).slice(norm(dir).length + 1)
    return rel ? `${rel}/` : 'session temp/'
  }
  return home && parent.startsWith(home) ? `~${parent.slice(home.length)}/` : `${parent}/`
}

export const sessionTempDir = (): string | null => sessionDir
