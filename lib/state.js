/**
 * Plugin-owned bookkeeping, kept outside the application bundle and outside the
 * profile's configuration so a reinstall or an upgrade cannot lose the backup
 * provenance.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Current state document version. */
export const STATE_VERSION = 1

/** Directory holding this plugin's own data. */
export const DATA_DIRECTORY = 'dsh-window-keeper-mac'

/**
 * Resolve the plugin data directory inside the running profile.
 * @returns {string} absolute directory path.
 */
export function pluginDataDirectory() {
  const fromEnvironment = process.env.DSH_PROFILE_DIR
  if (typeof fromEnvironment === 'string' && fromEnvironment !== '') {
    return path.join(fromEnvironment, 'plugin-data', DATA_DIRECTORY)
  }
  // The desktop host child receives no profile variable; its working directory
  // is the profile root, so prefer it when it carries profile markers.
  const cwd = process.cwd()
  const looksLikeProfile = fs.existsSync(path.join(cwd, 'cordis.patch.yml'))
    || fs.existsSync(path.join(cwd, 'cordis.yml'))
  const base = looksLikeProfile ? cwd : path.join(os.homedir(), '.dsh')
  return path.join(base, 'plugin-data', DATA_DIRECTORY)
}

/**
 * @returns {string} absolute state document path.
 */
export function statePath() {
  return path.join(pluginDataDirectory(), 'state.json')
}

/**
 * Read the state document, tolerating absence and corruption.
 * @returns {object} state with defaults filled in.
 */
export function readState() {
  const empty = {
    version: STATE_VERSION,
    appliedAt: null,
    appliedVersion: null,
    asarSize: null,
    asarMtimeMs: null,
    backupPath: null,
    backupVersion: null,
    lastResult: null,
    lastCheckedAt: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageState: null,
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return empty
    return { ...empty, ...parsed }
  } catch {
    return empty
  }
}

/**
 * Persist a state patch atomically.
 * @param {object} patch - fields to merge.
 * @returns {object} the stored state.
 */
export function writeState(patch) {
  const next = { ...readState(), ...patch, version: STATE_VERSION }
  try {
    fs.mkdirSync(pluginDataDirectory(), { recursive: true })
    const temporary = `${statePath()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, undefined, 2)}\n`)
    fs.renameSync(temporary, statePath())
  } catch {}
  return next
}