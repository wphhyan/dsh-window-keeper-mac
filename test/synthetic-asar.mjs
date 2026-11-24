/**
 * Build a minimal, valid asar archive for tests.
 *
 * Layout: [magic][pickle size][pickle payload length][JSON length][JSON][data].
 * Entries are laid out in the order given, offsets relative to the data section.
 */

import fs from 'node:fs'

/**
 * Write one archive.
 * @param {string} dest - output archive path, ending in `.asar`.
 * @param {Record<string, string | Buffer>} files - archive path → contents.
 * @returns {{ header: object, dataOffset: number }} layout facts.
 */
export function buildArchive(dest, files) {
  const header = { files: {} }
  const payloads = []
  let offset = 0
  for (const name of Object.keys(files)) {
    const bytes = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8')
    const segments = name.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error(`invalid archive path: ${name}`)
    let node = header
    for (const segment of segments.slice(0, -1)) {
      node.files[segment] ??= { files: {} }
      node = node.files[segment]
    }
    node.files[segments[segments.length - 1]] = { size: bytes.length, offset: String(offset) }
    payloads.push(bytes)
    offset += bytes.length
  }

  // Real archives carry alignment slack in the header; leave room so a repack
  // that grows one offset keeps the same header size.
  const json = Buffer.from(`${JSON.stringify(header)}${' '.repeat(512)}`, 'utf8')
  const pickleSize = json.length + 8
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(pickleSize, 4)
  prefix.writeUInt32LE(pickleSize - 4, 8)
  prefix.writeUInt32LE(json.length, 12)
  const previous = process.noAsar
  process.noAsar = true
  try {
    fs.writeFileSync(dest, Buffer.concat([prefix, json, ...payloads]))
  } finally {
    process.noAsar = previous
  }
  return { header, dataOffset: 16 + json.length }
}

/** A `lib/main.js` with the anchors the patch engine expects. */
export const PRISTINE_MAIN = `import { app, BrowserWindow } from "electron";

function createWindow(preload, show = false, primary = false) {
	const window = new BrowserWindow({
		width: 1280,
		height: 820,
		show
	});
	return window;
}

export { createWindow };
`

/** A `lib/main.js` the engine must refuse: no createWindow. */
export const UNPATCHABLE_MAIN = `import { app } from "electron";

function main() {
	return app;
}

export { main };
`