/**
 * Minimal asar reader for the DeepSeek Harness desktop bundle.
 *
 * Electron patches `node:fs` with an asar-aware layer inside its runtime, so a
 * direct open() of the archive itself gets rewritten; every read here runs with
 * `process.noAsar` switched off for exactly the duration of the call.
 *
 * The archive layout is: [4 bytes magic][4 bytes pickle size][pickle:
 * 4 bytes JSON length + JSON + padding]. File offsets are decimal strings
 * relative to the start of the data section at `8 + pickleSize`.
 */

import fs from 'node:fs'

const MAGIC = 4

/** Run one filesystem operation without Electron's asar interception. */
export function withPlainFs(operation) {
  const previous = process.noAsar
  process.noAsar = true
  try {
    return operation()
  } finally {
    process.noAsar = previous
  }
}

/**
 * Read the archive header.
 * @param {string} asarPath - absolute path of the .asar file.
 * @returns {{ header: object, dataOffset: number, fileSize: number }} layout facts.
 */
export function readAsarHeader(asarPath) {
  return withPlainFs(() => {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const fileSize = fs.fstatSync(fd).size
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      if (head.readUInt32LE(0) !== MAGIC) throw new Error('not an asar archive: bad magic')
      const pickleSize = head.readUInt32LE(4)
      const jsonLength = head.readUInt32LE(12)
      const json = Buffer.alloc(jsonLength)
      fs.readSync(fd, json, 0, jsonLength, 16)
      return {
        header: JSON.parse(json.toString('utf8')),
        dataOffset: 8 + pickleSize,
        pickleSize,
        jsonLength,
        fileSize,
      }
    } finally {
      fs.closeSync(fd)
    }
  })
}

/**
 * Resolve one entry by its archive path.
 * @param {object} header - parsed archive header.
 * @param {string} entryPath - path such as `/lib/main.js`.
 * @returns {{ size: number, offset: number, unpacked?: boolean } | undefined} entry, when present.
 */
export function findEntry(header, entryPath) {
  const segments = String(entryPath).split('/').filter(Boolean)
  let node = header
  for (const segment of segments) {
    if (node === undefined || typeof node !== 'object' || node.files === undefined) return undefined
    node = node.files[segment]
  }
  if (node === undefined || node.files !== undefined) return undefined
  return {
    size: Number(node.size),
    offset: Number(node.offset),
    ...node.unpacked === true ? { unpacked: true } : {},
  }
}

/**
 * Resolve one entry's node inside a parsed header, for in-place editing.
 * @param {object} header - parsed archive header.
 * @param {string} entryPath - path such as `/lib/main.js`.
 * @returns {object | undefined} the live header node.
 */
export function findEntryNode(header, entryPath) {
  const segments = String(entryPath).split('/').filter(Boolean)
  let node = header
  for (const segment of segments) {
    if (node === undefined || typeof node !== 'object' || node.files === undefined) return undefined
    node = node.files[segment]
  }
  if (node === undefined || node.files !== undefined) return undefined
  return node
}

/**
 * Remove one entry from a parsed header.
 * @param {object} header - parsed archive header.
 * @param {string} entryPath - path to remove.
 * @returns {boolean} whether an entry was removed.
 */
export function removeEntry(header, entryPath) {
  const segments = String(entryPath).split('/').filter(Boolean)
  if (segments.length === 0) return false
  let node = header
  for (const segment of segments.slice(0, -1)) {
    if (node === undefined || typeof node !== 'object' || node.files === undefined) return false
    node = node.files[segment]
  }
  const leaf = segments[segments.length - 1]
  if (node?.files === undefined || node.files[leaf] === undefined) return false
  delete node.files[leaf]
  return true
}

/**
 * Read one entry's bytes.
 * @param {string} asarPath - absolute path of the .asar file.
 * @param {string} entryPath - archive path of the entry.
 * @returns {Buffer} entry contents.
 */
export function readAsarEntry(asarPath, entryPath) {
  return readEntryFrom(asarPath, readAsarHeader(asarPath), entryPath)
}

/**
 * Read one entry with an already parsed layout, so callers inspecting several
 * entries pay for the header parse once.
 * @param {string} asarPath - absolute path of the .asar file.
 * @param {object} layout - result of {@link readAsarHeader}.
 * @param {string} entryPath - archive path of the entry.
 * @returns {Buffer} entry contents.
 */
export function readEntryFrom(asarPath, layout, entryPath) {
  const { header, dataOffset } = layout
  const entry = findEntry(header, entryPath)
  if (entry === undefined) throw new Error(`${entryPath} is not in ${asarPath}`)
  if (entry.unpacked === true) throw new Error(`${entryPath} is stored unpacked; not supported`)
  return withPlainFs(() => {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const buffer = Buffer.alloc(entry.size)
      fs.readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset)
      return buffer
    } finally {
      fs.closeSync(fd)
    }
  })
}

/**
 * Read and parse one JSON entry.
 * @param {string} asarPath - absolute path of the .asar file.
 * @param {string} entryPath - archive path of the entry.
 * @returns {object | undefined} parsed value, or undefined when absent or invalid.
 */
export function readAsarJson(asarPath, entryPath) {
  return readJsonFrom(asarPath, readAsarHeader(asarPath), entryPath)
}

/**
 * Parse a JSON entry using an already parsed layout.
 * @param {string} asarPath - absolute path of the .asar file.
 * @param {object} layout - result of {@link readAsarHeader}.
 * @param {string} entryPath - archive path of the entry.
 * @returns {object | undefined} parsed value, or undefined when absent or invalid.
 */
export function readJsonFrom(asarPath, layout, entryPath) {
  try {
    return JSON.parse(readEntryFrom(asarPath, layout, entryPath).toString('utf8'))
  } catch {
    return undefined
  }
}