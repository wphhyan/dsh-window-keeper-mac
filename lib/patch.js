/**
 * Window-memory patch engine: text edits on the Electron main process, and the
 * archive rewrite that installs them.
 *
 * The edits are anchored by patterns rather than line numbers or a build hash,
 * so the same engine works across DSH releases:
 *   1. the `import { ... } from "electron";` statement (adds `screen`);
 *   2. the `new BrowserWindow({ ... })` literal inside `createWindow`;
 *   3. a self-contained `window-state` region inserted above `createWindow`.
 *
 * The archive rewrite never moves an existing entry: it appends the new
 * `lib/main.js` at the end of the payload and repoints only that entry, keeping
 * the header size and payload base identical. Every other byte stays where it
 * was, so a half-written install can only damage the one file being replaced.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EPILOGUE, MARKER, PROLOGUE, REGION } from './region.js'
import { findEntry, findEntryNode, readAsarEntry, readAsarHeader, removeEntry, withPlainFs } from './asar.js'

/** The bundle does not match the shape this engine can edit; nothing was written. */
export class PatchError extends Error {}

const MAIN_PATH = '/lib/main.js'

/**
 * Build a staging archive path Electron's reader can open.
 *
 * Electron caches archives by path, so a name must never be reused within one
 * process: a cached reader would answer for the previous bytes and turn a good
 * install into a false failure.
 * @param {string} asarPath - live archive path.
 * @returns {string} unique sibling staging path ending in `.asar`.
 */
function stagingPathFor(asarPath) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return path.join(path.dirname(asarPath), `.window-keeper-staging-${unique}.asar`)
}

/**
 * SHA-256 of a whole file, read in bounded chunks.
 * @param {string} file - absolute path.
 * @returns {string} hex digest.
 */
function fileDigest(file) {
  return withPlainFs(() => {
    const hash = createHash('sha256')
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const chunk = Buffer.alloc(8 * 1024 * 1024)
      let done = 0
      while (done < size) {
        const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - done), done)
        if (read <= 0) break
        hash.update(chunk.subarray(0, read))
        done += read
      }
    } finally {
      fs.closeSync(fd)
    }
    return hash.digest('hex')
  })
}

/**
 * Locate the electron import statement that carries BrowserWindow.
 * @param {string} source - `lib/main.js` text.
 * @returns {{ start: number, end: number, names: string[], commaSpace: boolean }} statement facts.
 */
function findElectronImport(source) {
  const pattern = /import\s*\{([^}]*)\}\s*from\s*"electron";/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    if (match[1].includes('BrowserWindow')) {
      const names = match[1].split(',').map(name => name.trim()).filter(Boolean)
      return {
        start: match.index,
        end: match.index + match[0].length,
        names,
        commaSpace: match[1].includes(', '),
      }
    }
  }
  throw new PatchError('未找到带 BrowserWindow 的 `import { … } from "electron";`')
}

/**
 * Return the index just past the brace closing `source[openIndex]`, skipping
 * string, template and comment content.
 * @param {string} source - text to scan.
 * @param {number} openIndex - index of `{`, `(` or `[`.
 * @returns {number} index just past the matching closer.
 */
function matchBrace(source, openIndex) {
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const stack = []
  let i = openIndex
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i)
      if (newline < 0) break
      i = newline
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (pairs[ch] !== undefined) stack.push(pairs[ch])
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) {
        throw new PatchError(`花括号不平衡：遇到 ${JSON.stringify(ch)}`)
      }
      stack.pop()
      if (stack.length === 0) return i + 1
    }
    i += 1
  }
  throw new PatchError('花括号没有闭合')
}

/**
 * Return the inner span of the createWindow function body.
 * @param {string} source - `lib/main.js` text.
 * @returns {{ bodyStart: number, bodyEnd: number }} offsets excluding the braces.
 */
function findCreateWindowBody(source) {
  const match = /function\s+createWindow\s*\(/.exec(source)
  if (match === null) throw new PatchError('未找到 `function createWindow(`')
  const paren = source.indexOf('(', match.index)
  const parenEnd = matchBrace(source, paren)
  const brace = source.indexOf('{', parenEnd)
  if (brace < 0) throw new PatchError('createWindow 没有函数体')
  return { bodyStart: brace + 1, bodyEnd: matchBrace(source, brace) - 1 }
}

/**
 * Recover the width/height the bundle falls back to.
 * @param {string} source - pristine or already patched `lib/main.js` text.
 * @returns {{ width: string, height: string }} decimal literals.
 */
export function detectDefaults(source) {
  if (source.includes(MARKER)) {
    const width = /const WINDOW_STATE_DEFAULT_WIDTH = (\d+);/.exec(source)
    const height = /const WINDOW_STATE_DEFAULT_HEIGHT = (\d+);/.exec(source)
    if (width === null || height === null) {
      throw new PatchError('已存在注入区，但默认宽高常量缺失')
    }
    return { width: width[1], height: height[1] }
  }
  const { bodyStart, bodyEnd } = findCreateWindowBody(source)
  const body = source.slice(bodyStart, bodyEnd)
  const call = /new\s+BrowserWindow\s*\(\s*\{/.exec(body)
  if (call === null) throw new PatchError('createWindow 里没有 BrowserWindow 字面量参数')
  const optionsOpen = body.indexOf('{', call.index)
  const options = body.slice(optionsOpen, matchBrace(body, optionsOpen) - 1)
  const dims = /\bwidth:\s*(\d+)[ \t]*,\s*height:\s*(\d+)[ \t]*,/.exec(options)
  if (dims === null) throw new PatchError('BrowserWindow 参数里没有 `width: N, height: N,` 字面量')
  return { width: dims[1], height: dims[2] }
}

/**
 * Apply the three edits to a pristine `lib/main.js`.
 * @param {string} source - pristine text.
 * @returns {string} patched text.
 */
export function patchSource(source) {
  let text = source

  const statement = findElectronImport(text)
  let names = statement.names
  if (!names.includes('screen')) {
    const sep = statement.commaSpace ? ', ' : ','
    names = [...names, 'screen']
    text = `${text.slice(0, statement.start)}import { ${names.join(sep)} } from "electron";${text.slice(statement.end)}`
  }

  const { bodyStart, bodyEnd } = findCreateWindowBody(text)
  let body = text.slice(bodyStart, bodyEnd)
  if (body.includes('windowStatePath')) throw new PatchError('createWindow 已带有 window-state 前置代码')

  const call = /new\s+BrowserWindow\s*\(\s*\{/.exec(body)
  if (call === null) throw new PatchError('createWindow 里没有 BrowserWindow 字面量参数')
  const optionsOpen = body.indexOf('{', call.index)
  const optionsClose = matchBrace(body, optionsOpen) - 1
  const options = body.slice(optionsOpen, optionsClose)
  const dims = /\bwidth:\s*(\d+)[ \t]*,\s*height:\s*(\d+)[ \t]*,/.exec(options)
  if (dims === null) throw new PatchError('BrowserWindow 参数里没有 `width: N, height: N,` 字面量')
  const defaults = { width: dims[1], height: dims[2] }

  const injected = 'width: restoredWindowState?.width ?? WINDOW_STATE_DEFAULT_WIDTH,\n'
    + '\t\theight: restoredWindowState?.height ?? WINDOW_STATE_DEFAULT_HEIGHT,\n'
    + '\t\t...(restoredWindowState?.x === void 0 ? {} : {\n'
    + '\t\t\tx: restoredWindowState.x,\n'
    + '\t\t\ty: restoredWindowState.y\n'
    + '\t\t}),'
  body = body.slice(0, optionsOpen) + options.slice(0, dims.index) + injected
    + options.slice(dims.index + dims[0].length) + body.slice(optionsClose)

  const leading = body.length - body.replace(/^\s+/, '').length
  body = body.slice(0, leading) + PROLOGUE + body.slice(leading)

  const returns = [...body.matchAll(/\breturn\s+window\s*;/g)]
  if (returns.length === 0) throw new PatchError('createWindow 里没有 `return window;`')
  const last = returns[returns.length - 1]
  body = body.slice(0, last.index) + EPILOGUE + body.slice(last.index)

  text = text.slice(0, bodyStart) + body + text.slice(bodyEnd)

  if (text.includes(MARKER)) throw new PatchError('注入区已经存在')
  const anchor = /function\s+createWindow\s*\(/.exec(text)
  text = text.slice(0, anchor.index) + REGION + text.slice(anchor.index)

  return text
    .replace('const WINDOW_STATE_DEFAULT_WIDTH = 1280;', `const WINDOW_STATE_DEFAULT_WIDTH = ${defaults.width};`)
    .replace('const WINDOW_STATE_DEFAULT_HEIGHT = 820;', `const WINDOW_STATE_DEFAULT_HEIGHT = ${defaults.height};`)
}

/**
 * Rewrite an archive so that `lib/main.js` holds `newMain`, leaving every other
 * entry byte-identical at its original offset.
 * @param {string} asarPath - pristine archive to read.
 * @param {string} destPath - archive to write.
 * @param {Buffer} newMain - replacement `lib/main.js` bytes.
 */
function repack(asarPath, destPath, newMain) {
  const layout = readAsarHeader(asarPath)
  const original = withPlainFs(() => fs.readFileSync(asarPath))
  const data = original.subarray(layout.dataOffset)
  const header = structuredClone(layout.header)
  const entry = findEntry(header, MAIN_PATH)
  if (entry === undefined) throw new PatchError('app.asar 里没有 lib/main.js')
  if (entry.unpacked === true) throw new PatchError('lib/main.js 是 unpacked 存放，无法重打包')

  const mainEntry = findEntryNode(header, MAIN_PATH)
  if (mainEntry === undefined) throw new PatchError('app.asar 里没有 lib/main.js 节点')
  delete mainEntry.integrity

  const atTail = entry.offset + entry.size === data.length
  const payload = atTail ? data.subarray(0, entry.offset) : data
  mainEntry.offset = String(payload.length)
  mainEntry.size = newMain.length

  const json = Buffer.from(JSON.stringify(header), 'utf8')
  if (json.length > layout.jsonLength) {
    throw new PatchError(`新 header 超出原有大小（${json.length} > ${layout.jsonLength}）`)
  }
  const padding = layout.dataOffset - 16 - layout.jsonLength
  if (padding < 0) throw new PatchError('header 填充长度为负')

  // The first 16 bytes are a pickle envelope: magic, pickle size, pickle
  // payload length, JSON length. Electron's own reader parses the pickle, so
  // all four fields must survive verbatim; rebuilding the envelope dropped the
  // payload length and made the archive unreadable at launch.
  const prefix = Buffer.from(original.subarray(0, 16))
  if (prefix.readUInt32LE(4) !== layout.pickleSize) throw new PatchError('pickle 大小与解析结果不一致')
  if (prefix.readUInt32LE(12) !== layout.jsonLength) throw new PatchError('JSON 长度与解析结果不一致')
  if (prefix.readUInt32LE(8) !== layout.pickleSize - 4) throw new PatchError('pickle 载荷长度与解析结果不一致')
  const padded = Buffer.concat([json, Buffer.alloc(layout.jsonLength - json.length, 0x20)])

  withPlainFs(() => {
    const fd = fs.openSync(destPath, 'w')
    try {
      fs.writeSync(fd, prefix, 0, 16)
      fs.writeSync(fd, padded, 0, padded.length, 16)
      if (padding > 0) fs.writeSync(fd, Buffer.alloc(padding), 0, padding, 16 + layout.jsonLength)
      if (payload.length > 0) fs.writeSync(fd, payload, 0, payload.length, layout.dataOffset)
      if (newMain.length > 0) fs.writeSync(fd, newMain, 0, newMain.length, layout.dataOffset + payload.length)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
}

/**
 * Compare two archives byte-for-byte over one contiguous range.
 * @param {string} leftPath - archive to compare from.
 * @param {number} leftOffset - start offset in `leftPath`.
 * @param {string} rightPath - archive to compare against.
 * @param {number} rightOffset - start offset in `rightPath`.
 * @param {number} length - number of bytes to compare.
 * @returns {boolean} whether the ranges are identical.
 */
function compareRange(leftPath, leftOffset, rightPath, rightOffset, length) {
  const chunk = 8 * 1024 * 1024
  return withPlainFs(() => {
    const left = fs.openSync(leftPath, 'r')
    const right = fs.openSync(rightPath, 'r')
    try {
      const a = Buffer.alloc(chunk)
      const b = Buffer.alloc(chunk)
      let done = 0
      while (done < length) {
        const size = Math.min(chunk, length - done)
        fs.readSync(left, a, 0, size, leftOffset + done)
        fs.readSync(right, b, 0, size, rightOffset + done)
        if (Buffer.compare(a.subarray(0, size), b.subarray(0, size)) !== 0) return false
        done += size
      }
      return true
    } finally {
      fs.closeSync(left)
      fs.closeSync(right)
    }
  })
}

/**
 * Assert the patched archive is structurally identical to its pristine source
 * except for `lib/main.js`.
 * @param {string} patchedPath - rewritten archive.
 * @param {string} pristinePath - archive it was derived from.
 * @param {Buffer} expectedMain - bytes `lib/main.js` must now hold.
 */
export function verifyArchive(patchedPath, pristinePath, expectedMain) {
  const pristine = readAsarHeader(pristinePath)
  const patched = readAsarHeader(patchedPath)
  if (patched.dataOffset !== pristine.dataOffset) {
    throw new PatchError(`数据区基址发生变化（${pristine.dataOffset} → ${patched.dataOffset}）`)
  }
  const left = structuredClone(pristine.header)
  const right = structuredClone(patched.header)
  removeEntry(left, MAIN_PATH)
  removeEntry(right, MAIN_PATH)
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new PatchError('除 lib/main.js 外的 header 条目发生了变化')
  }
  const dataLength = pristine.fileSize - pristine.dataOffset
  if (!compareRange(patchedPath, patched.dataOffset, pristinePath, pristine.dataOffset, dataLength)) {
    throw new PatchError('数据区内容与原始包不一致')
  }
  const main = readAsarEntry(patchedPath, MAIN_PATH)
  if (!main.equals(expectedMain)) throw new PatchError('写入后的 lib/main.js 与预期不一致')
}

/**
 * Read entries through Electron's own asar reader.
 *
 * This is the check that matters: the application crashed at launch while the
 * header envelope was malformed, even though this plugin's own parser accepted
 * it. The reader is only reachable through the un-patched `node:fs`, and its
 * archive path must end at an `.asar` segment.
 * @param {string} archivePath - archive whose name ends with `.asar`.
 * @param {string} expectedMain - exact `lib/main.js` bytes it must expose.
 */
export function verifyWithElectronReader(archivePath, expectedMain) {
  if (process.versions.electron === undefined) {
    throw new PatchError('Electron 的 asar 读取器不可用，拒绝安装未经真实读取验证的包')
  }
  const previous = process.noAsar
  process.noAsar = false
  try {
    const main = fs.readFileSync(`${archivePath}/lib/main.js`)
    if (!main.equals(expectedMain)) throw new PatchError('Electron 读取到的 lib/main.js 与预期不一致')
    const pkg = JSON.parse(fs.readFileSync(`${archivePath}/package.json`, 'utf8'))
    if (typeof pkg?.name !== 'string' || pkg.name === '') {
      throw new PatchError('Electron 无法读取归档的 package.json')
    }
    fs.readFileSync(`${archivePath}/lib/preload-app.cjs`)
  } catch (error) {
    if (error instanceof PatchError) throw error
    throw new PatchError(`Electron 无法读取重打包后的归档：${error?.message ?? String(error)}`)
  } finally {
    process.noAsar = previous
  }
}

/**
 * Parse-check a `lib/main.js` text with the running Electron executable.
 * @param {string} source - patched module text.
 * @param {string} tempDirectory - directory for the temporary module file.
 * @returns {{ ok: boolean, output: string }} syntax outcome.
 */
export function checkSyntax(source, tempDirectory) {
  const file = path.join(tempDirectory, `main.check-${process.pid}.mjs`)
  fs.mkdirSync(tempDirectory, { recursive: true })
  fs.writeFileSync(file, source)
  try {
    const result = spawnSync(process.execPath, ['--check', file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

/**
 * Install the patch into an archive, deriving the pristine text from the live
 * bundle when it is unpatched.
 * @param {object} options - install inputs.
 * @param {string} options.asarPath - live application archive.
 * @param {string} options.tempDirectory - scratch directory for staging files.
 * @returns {{ patchedBytes: number, originalBytes: number }} size facts.
 */
export function installIntoArchive({ asarPath, tempDirectory }) {
  const current = readAsarEntry(asarPath, MAIN_PATH).toString('utf8')
  if (current.includes(MARKER)) throw new PatchError('当前应用已经带有窗口记忆补丁')
  const patched = patchSource(current)
  const patchedBytes = Buffer.from(patched, 'utf8')
  const syntax = checkSyntax(patched, tempDirectory)
  if (!syntax.ok) throw new PatchError(`打补丁后的 main.js 语法检查失败：${syntax.output}`)

  const staging = stagingPathFor(asarPath)
  repack(asarPath, staging, patchedBytes)
  try {
    verifyArchive(staging, asarPath, patchedBytes)
    verifyWithElectronReader(staging, patchedBytes)
    const digest = fileDigest(staging)
    withPlainFs(() => fs.renameSync(staging, asarPath))
    if (fileDigest(asarPath) !== digest) throw new PatchError('写入正式位置后字节与暂存文件不一致')
  } catch (error) {
    try { withPlainFs(() => fs.rmSync(staging, { force: true })) } catch {}
    throw error
  }
  return { patchedBytes: patchedBytes.length, originalBytes: Buffer.byteLength(current, 'utf8') }
}

/**
 * Replace the live archive with a pristine backup.
 * @param {object} options - revert inputs.
 * @param {string} options.asarPath - live application archive.
 * @param {string} options.backupPath - pristine archive to restore.
 * @param {string} options.tempDirectory - scratch directory for staging files.
 */
export function revertFromBackup({ asarPath, backupPath, tempDirectory }) {
  if (!withPlainFs(() => fs.existsSync(backupPath))) throw new PatchError('没有可用的官方备份，无法一键还原')
  const backupMain = readAsarEntry(backupPath, MAIN_PATH).toString('utf8')
  if (backupMain.includes(MARKER)) throw new PatchError('备份里已经含有补丁，不能作为还原基线')

  const staging = stagingPathFor(asarPath)
  const backupBytes = Buffer.from(backupMain, 'utf8')
  withPlainFs(() => fs.copyFileSync(backupPath, staging))
  try {
    verifyArchive(staging, backupPath, backupBytes)
    verifyWithElectronReader(staging, backupBytes)
    const digest = fileDigest(staging)
    withPlainFs(() => fs.renameSync(staging, asarPath))
    if (fileDigest(asarPath) !== digest) throw new PatchError('还原后字节与备份不一致')
  } catch (error) {
    try { withPlainFs(() => fs.rmSync(staging, { force: true })) } catch {}
    throw error
  }
  void tempDirectory
}

/**
 * Whether a backup is a valid baseline for the live archive: same app version
 * and every entry other than `lib/main.js` identical.
 * @param {string} backupPath - candidate backup.
 * @param {string} asarPath - live archive.
 * @returns {boolean} whether restoring the backup only changes `lib/main.js`.
 */
export function isBaselineFor(backupPath, asarPath) {
  try {
    const pristine = readAsarHeader(backupPath)
    const live = readAsarHeader(asarPath)
    if (pristine.dataOffset !== live.dataOffset) return false
    const left = structuredClone(pristine.header)
    const right = structuredClone(live.header)
    removeEntry(left, MAIN_PATH)
    removeEntry(right, MAIN_PATH)
    if (JSON.stringify(left) !== JSON.stringify(right)) return false
    const dataLength = pristine.fileSize - pristine.dataOffset
    if (dataLength > live.fileSize - live.dataOffset) return false
    return compareRange(backupPath, pristine.dataOffset, asarPath, live.dataOffset, dataLength)
  } catch {
    return false
  }
}
/**
 * Prepare the pristine archive this plugin can restore later.
 * @param {object} options - backup inputs.
 * @param {string} options.asarPath - live archive, currently pristine.
 * @param {string} options.backupPath - backup path to fill.
 * @param {string} options.version - running application version.
 * @param {string | null} options.previousVersion - version the existing backup belongs to.
 * @returns {{ created: boolean, rotatedTo: string | null }} backup outcome.
 */
export function prepareBackup({ asarPath, backupPath, version, previousVersion }) {
  return withPlainFs(() => {
    const exists = fs.existsSync(backupPath)
    if (exists && previousVersion === version && isBaselineFor(backupPath, asarPath)) {
      return { created: false, rotatedTo: null }
    }
    let rotatedTo = null
    if (exists) {
      const target = `${backupPath}.v${previousVersion ?? 'unknown'}`
      try {
        fs.rmSync(target, { force: true })
        fs.renameSync(backupPath, target)
        rotatedTo = target
      } catch {
        fs.rmSync(backupPath, { force: true })
      }
    }
    fs.copyFileSync(asarPath, backupPath)
    return { created: true, rotatedTo }
  })
}
