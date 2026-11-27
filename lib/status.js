/**
 * Read-only inspection of the desktop window-memory patch and its saved geometry.
 *
 * The patch lives in the Electron main process (`lib/main.js` inside
 * `app.asar`), because only the main process creates a BrowserWindow. This module
 * never writes to the application bundle; it reports what is installed so the
 * plugin row, the settings switch, and the agent can tell whether the next launch
 * will restore the window size.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { readAsarJson, readAsarHeader, readEntryFrom, readJsonFrom, withPlainFs } from './asar.js'

/** Region marker the main-process patch inserts before `createWindow`. */
export const PATCH_MARKER = '//#region lib/types/window-state.js'

/** Default install location of the desktop application bundle. */
export const DEFAULT_APP_PATH = '/Applications/DeepSeek Harness.app'

const ANCHORS = {
  electronImport: { label: 'electron 导入', pattern: /from\s+["']electron["']/ },
  createWindow: { label: 'createWindow 函数', pattern: /function\s+createWindow\s*\(/ },
  browserWindow: { label: 'BrowserWindow 构造', pattern: /new\s+BrowserWindow\s*\(\s*\{/ },
}

/**
 * @param {string} file - Info.plist path.
 * @param {string} key - string key to read.
 * @returns {string | undefined} value, when the plist is XML and carries the key.
 */
function readPlistString(file, key) {
  try {
    const xml = fs.readFileSync(file, 'utf8')
    const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * Resolve the desktop application bundle and its archive.
 * @param {string | undefined} configured - configured bundle path, when the user set one.
 * @param {string} execPath - `process.execPath` of the Host process.
 * @returns {{ bundle: string, asar: string, infoPlist: string } | undefined} located bundle.
 */
export function locateAppBundle(configured, execPath) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  if (typeof execPath === 'string' && execPath.includes('.app/Contents/MacOS/')) {
    candidates.push(path.resolve(execPath, '../../..'))
  }
  candidates.push(DEFAULT_APP_PATH)
  const seen = new Set()
  for (const bundle of candidates) {
    if (seen.has(bundle)) continue
    seen.add(bundle)
    const asar = path.join(bundle, 'Contents', 'Resources', 'app.asar')
    try {
      if (!withPlainFs(() => fs.statSync(asar).isFile())) continue
      return { bundle, asar, infoPlist: path.join(bundle, 'Contents', 'Info.plist') }
    } catch {}
  }
  return undefined
}

/** Package names already read from an archive, invalidated by its stat. */
const archiveNameCache = new Map()

/**
 * Resolve the Electron `userData` directory the patch writes into.
 *
 * Parsing the whole archive header for one field costs ~20 MB of temporary
 * objects, and this runs on every refresh, so the result is cached by stat.
 * @param {string} asarPath - application archive.
 * @returns {string | undefined} userData directory, when the package name is readable.
 */
function resolveUserData(asarPath) {
  let name
  try {
    const stat = withPlainFs(() => fs.statSync(asarPath))
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`
    const cached = archiveNameCache.get(asarPath)
    if (cached !== undefined && cached.key === key) {
      name = cached.name
    } else {
      name = readJsonFrom(asarPath, readAsarHeader(asarPath), '/package.json')?.name
      archiveNameCache.set(asarPath, { key, name })
    }
  } catch {
    name = readAsarJson(asarPath, '/package.json')?.name
  }
  if (typeof name !== 'string' || name === '') return undefined
  return path.join(os.homedir(), 'Library', 'Application Support', name)
}

/**
 * @param {number} value - candidate dimension.
 * @returns {number | undefined} rounded integer, for finite numbers only.
 */
function dimension(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

/**
 * Read the geometry the patch saved on the last quit.
 * @param {string} userData - Electron userData directory.
 * @returns {{ saved: object | undefined, file: string, log: string, lastRestore: string | undefined }} saved facts and paths.
 */
function readSavedGeometry(userData) {
  const directory = path.join(userData, 'desktop')
  const file = path.join(directory, 'window-state.json')
  const log = path.join(directory, 'window-state.log')
  let saved
  try {
    const stat = fs.statSync(file)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const width = dimension(doc?.bounds?.width)
    const height = dimension(doc?.bounds?.height)
    if (width !== undefined && height !== undefined) {
      saved = {
        width,
        height,
        x: dimension(doc?.bounds?.x),
        y: dimension(doc?.bounds?.y),
        maximized: doc?.maximized === true,
        at: new Date(stat.mtimeMs).toLocaleString('zh-CN'),
      }
    }
  } catch {}
  let lastRestore
  try {
    const stat = fs.statSync(log)
    const length = Math.min(stat.size, 8192)
    const fd = fs.openSync(log, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length))
      const lines = buffer.toString('utf8').split('\n').filter(line => line.includes('restore:'))
      lastRestore = lines.at(-1)?.slice(0, 220)
    } finally {
      fs.closeSync(fd)
    }
  } catch {}
  return { saved, file, log, lastRestore }
}

/** Parsed main-process facts, keyed by archive path and invalidated by its stat. */
const mainProcessCache = new Map()

/**
 * Inspect the main-process code the window geometry depends on.
 *
 * Reading and scanning `lib/main.js` costs ~1 MB per pass, and settings events
 * are frequent, so the result is reused until the archive's size or mtime moves.
 * @param {string} asarPath - application archive.
 * @returns {{ regionCount: number, missingAnchors: string[], mainHash: string, asarMtimeMs: number }} patch facts.
 */
function analyzeMainProcess(asarPath) {
  const stat = withPlainFs(() => fs.statSync(asarPath))
  const cacheKey = `${stat.size}:${Math.round(stat.mtimeMs)}`
  const cached = mainProcessCache.get(asarPath)
  if (cached !== undefined && cached.key === cacheKey) return cached.value
  const value = scanMainProcess(asarPath, readAsarHeader(asarPath), stat.mtimeMs)
  mainProcessCache.set(asarPath, { key: cacheKey, value })
  return value
}

/**
 * @param {string} asarPath - application archive.
 * @param {number} mtimeMs - archive modification time to report.
 * @returns {{ regionCount: number, missingAnchors: string[], mainHash: string, asarMtimeMs: number }} patch facts.
 */
function scanMainProcess(asarPath, layout, mtimeMs) {
  const text = readEntryFrom(asarPath, layout, '/lib/main.js').toString('utf8')
  const regionCount = text.split(PATCH_MARKER).length - 1
  const missingAnchors = Object.values(ANCHORS)
    .filter(anchor => !anchor.pattern.test(text))
    .map(anchor => anchor.label)
  return {
    regionCount,
    missingAnchors,
    mainHash: createHash('sha256').update(text).digest('hex'),
    asarMtimeMs: mtimeMs,
  }
}

/**
 * @param {number} regionCount - patch region occurrences in `lib/main.js`.
 * @param {string[]} missingAnchors - anchors the patch needs that are absent.
 * @returns {'enabled' | 'absent' | 'unpatchable'} state.
 */
function classify(regionCount, missingAnchors) {
  if (regionCount === 1 && missingAnchors.length === 0) return 'enabled'
  if (regionCount === 0 && missingAnchors.length === 0) return 'absent'
  return 'unpatchable'
}

/**
 * Read the version recorded inside a backup archive, when it matches the
 * running app version.
 * @param {string} backupPath - `app.asar.window-keeper.bak` path.
 * @param {string} appVersion - version of the running application.
 * @returns {string | undefined} matching version, or undefined.
 */
export function backupVersionFor(backupPath, appVersion) {
  const pkg = readAsarJson(backupPath, '/package.json')
  const version = typeof pkg?.version === 'string' ? pkg.version : undefined
  return version === appVersion ? version : undefined
}

/**
 * Summarize the backup this plugin owns, when it still belongs to this release.
 * @param {object} state - persisted plugin state.
 * @param {string} version - running application version.
 * @returns {string} short description for the report.
 */
function describeBackup(state, version, asarPath) {
  const candidate = typeof state.backupPath === 'string' && state.backupPath !== ''
    ? state.backupPath
    : `${asarPath}.window-keeper.bak`
  const exists = withPlainFs(() => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  if (!exists) return '无'
  // The state file can be lost (new profile, renamed package); the backup itself
  // still knows which release it came from through its bundled package.json.
  const backupVersion = state.backupVersion
    ?? readAsarJson(candidate, '/package.json')?.version
    ?? undefined
  if (backupVersion === undefined) return '官方备份'
  return backupVersion === version ? `官方备份 · ${version}` : `旧版本备份 · ${backupVersion}`
}

/**
 * Read the complete window-memory status.
 * @param {object} options - inspection inputs.
 * @param {string | undefined} options.appPath - configured bundle path.
 * @param {string} options.execPath - `process.execPath` of the Host process.
 * @param {object} options.state - persisted plugin state.
 * @returns {object} flat, losslessly JSON-serializable status report.
 */
export function inspectWindowKeeper({ appPath, execPath, state }) {
  const located = locateAppBundle(appPath, execPath)
  if (located === undefined) {
    return {
      state: 'not-found',
      summary: '未找到 DeepSeek Harness 桌面应用包，当前环境可能是 Web 或源码运行。',
      appVersion: '',
      appPath: '',
      regionCount: 0,
      pendingRestart: false,
      savedBounds: '无',
      savedMaximized: '未知',
      savedAt: '无',
      lastRestore: '无',
      backup: '无',
      notes: '仅在 DeepSeek Harness 桌面版（Electron）中可用。',
    }
  }
  const version = readPlistString(located.infoPlist, 'CFBundleShortVersionString') ?? ''
  const userData = resolveUserData(located.asar)
  const geometry = userData === undefined
    ? { saved: undefined, file: '', log: '', lastRestore: undefined }
    : readSavedGeometry(userData)
  const { regionCount, missingAnchors, mainHash, asarMtimeMs } = analyzeMainProcess(located.asar)
  const base = classify(regionCount, missingAnchors)
  const hostStartedAt = Date.now() - process.uptime() * 1000
  const appliedAtMs = Date.parse(typeof state.appliedAt === 'string' ? state.appliedAt : '')
  // A recorded apply that happened after this process started is the honest
  // signal; the archive mtime only covers state written by another profile.
  const pendingRestart = base === 'enabled' && (Number.isFinite(appliedAtMs)
    ? appliedAtMs > hostStartedAt + 1500
    : asarMtimeMs > hostStartedAt + 1500)
  const saved = geometry.saved
  const covered = base === 'absent' && typeof state.appliedAt === 'string' && state.appliedAt !== ''

  let savedBounds = '暂无存档'
  if (saved !== undefined) {
    const position = saved.x === undefined || saved.y === undefined ? '' : ` @ (${saved.x}, ${saved.y})`
    savedBounds = `${saved.width}×${saved.height}${position}`
  }

  let summary
  let notes
  if (base === 'enabled') {
    summary = pendingRestart
      ? '已启用，需重启生效：补丁刚写入应用包，当前进程仍在用旧代码。'
      : '已启用：下次启动会恢复上次关闭时的窗口大小。'
    notes = saved === undefined ? '补丁已就位，但还没有存档；正常退出一次后会生成。' : ''
  } else if (base === 'absent') {
    summary = covered
      ? state.appliedVersion === version
        ? `未启用：当前 ${version} 的 app.asar 没有补丁（上次应用于同一版本，可能被手工还原）。`
        : `未启用：当前 ${version} 覆盖了补丁（上次应用于 ${state.appliedVersion}）。`
      : '未启用：补丁尚未安装到当前应用版本。'
    notes = '打开「重新启用」开关即可打补丁；应用后需要 ⌘Q 重启。'
  } else {
    summary = '无法自动适配：主进程结构不符合补丁锚点，需要人工核对。'
    notes = missingAnchors.length > 0
      ? `缺少锚点：${missingAnchors.join('、')}。`
      : `注入区出现 ${regionCount} 处（应为 1 处），可能重复打补丁。`
  }
  if (notes !== '') notes = `${notes}main.js 指纹 ${mainHash.slice(0, 12)}…`
  else notes = `main.js 指纹 ${mainHash.slice(0, 12)}…`

  return {
    state: base,
    summary,
    appVersion: version,
    appPath: located.bundle,
    regionCount,
    pendingRestart,
    savedBounds,
    savedMaximized: saved === undefined ? '未知' : saved.maximized ? '是' : '否',
    savedAt: saved?.at ?? '无',
    lastRestore: geometry.lastRestore ?? '无',
    backup: describeBackup(state, version, located.asar),
    notes,
  }
}