/**
 * Engine tests on synthetic archives: no real DSH installation is touched.
 *
 * Run with plain Node (our reader is used as the fallback) or with
 * `ELECTRON_RUN_AS_NODE=1 <electron> test/patch.test.mjs` to exercise Electron's
 * own asar reader as well.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildArchive, PRISTINE_MAIN, UNPATCHABLE_MAIN } from './synthetic-asar.mjs'
import { installIntoArchive, patchSource, prepareBackup, revertFromBackup } from '../lib/patch.js'
import { readAsarEntry, withPlainFs } from '../lib/asar.js'
import { backupVersionFor } from '../lib/status.js'
import { MARKER } from '../lib/region.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-keeper-test-'))
const scratch = path.join(root, 'scratch')

const packageJson = JSON.stringify({ name: '@test/fixture', version: '0.0.0' })

/**
 * Aim the engine at one freshly built archive.
 * @param {string} mainSource - `lib/main.js` contents.
 * @param {string} name - archive base name.
 * @returns {{ asar: string, backup: string, pristineMain: string }} fixture paths.
 */
function fixture(mainSource, name) {
  const asar = path.join(root, `${name}.asar`)
  const backup = `${asar}.window-keeper.bak`
  buildArchive(asar, {
    '/package.json': packageJson,
    '/lib/main.js': mainSource,
    '/lib/preload-app.cjs': '// preload\n',
  })
  return { asar, backup, pristineMain: mainSource }
}

try {
  // 1. apply → one region, exact engine output, other entries untouched
  const applied = fixture(PRISTINE_MAIN, 'apply')
  prepareBackup({
    asarPath: applied.asar,
    backupPath: applied.backup,
    version: '0.0.0',
    previousVersion: null,
  })
  assert.ok(withPlainFs(() => fs.existsSync(applied.backup)), 'backup was created')

  installIntoArchive({ asarPath: applied.asar, tempDirectory: scratch })
  const patched = readAsarEntry(applied.asar, '/lib/main.js').toString('utf8')
  assert.equal(patched.split(MARKER).length - 1, 1, 'exactly one patch region')
  assert.equal(patched, patchSource(applied.pristineMain), 'engine output is stable')
  assert.equal(
    readAsarEntry(applied.asar, '/package.json').toString('utf8'),
    packageJson,
    'other entries are untouched',
  )

  // 2. revert → byte-identical to the pristine backup
  revertFromBackup({ asarPath: applied.asar, backupPath: applied.backup, tempDirectory: scratch })
  assert.equal(
    withPlainFs(() => fs.readFileSync(applied.asar)).equals(withPlainFs(() => fs.readFileSync(applied.backup))),
    true,
    'revert restores the pristine archive',
  )
  assert.equal(
    readAsarEntry(applied.asar, '/lib/main.js').toString('utf8').includes(MARKER),
    false,
    'revert removes the region',
  )

  // 3. an archive without createWindow is refused, and nothing is written
  const unpatchable = fixture(UNPATCHABLE_MAIN, 'unpatchable')
  const before = withPlainFs(() => fs.readFileSync(unpatchable.asar))
  assert.throws(
    () => installIntoArchive({ asarPath: unpatchable.asar, tempDirectory: scratch }),
    /BrowserWindow|createWindow/,
    'unpatchable bundles are refused',
  )
  assert.equal(withPlainFs(() => fs.readFileSync(unpatchable.asar)).equals(before), true, 'refusal leaves the archive intact')

  // 4. installing into an already patched archive is refused
  const twice = fixture(PRISTINE_MAIN, 'twice')
  installIntoArchive({ asarPath: twice.asar, tempDirectory: scratch })
  assert.throws(
    () => installIntoArchive({ asarPath: twice.asar, tempDirectory: scratch }),
    /已经带有窗口记忆补丁/,
    'a patched archive is not patched twice',
  )

  // 5. a backup only counts for the running version — the adoption path relies on it
  const versioned = fixture(PRISTINE_MAIN, 'versioned')
  assert.equal(backupVersionFor(versioned.asar, '0.0.0'), '0.0.0', 'matching backup version is accepted')
  assert.equal(backupVersionFor(versioned.asar, '9.9.9'), undefined, 'a different app version is rejected')

  console.log(`ok: 5 engine checks passed (${process.versions.electron === undefined ? 'node reader' : 'electron reader'})`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}