/**
 * Window memory keeper — Host half.
 *
 * The window geometry itself is saved and restored by the Electron main process;
 * a plugin runs in the desktop host child process and cannot reach a BrowserWindow.
 * This plugin owns everything around that patch: it reports whether the patch is
 * still in place after a DSH upgrade, applies it again when the user turns the
 * settings switch on, and keeps a pristine backup for a one-step revert.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { backupVersionFor, inspectWindowKeeper } from './lib/status.js'
import {
  PatchError,
  installIntoArchive,
  isBaselineFor,
  prepareBackup,
  revertFromBackup,
} from './lib/patch.js'
import { pluginDataDirectory, readState, writeState } from './lib/state.js'
import { readAsarHeader } from './lib/asar.js'

export const name = 'window-keeper-mac'

export const inject = ['tools', 'configEditor']

/**
 * Load the schema factory.
 *
 * A linked development bundle resolves its imports from its own directory, which
 * need not sit under the profile's `node_modules`; fall back to the schema copy
 * that ships with the running dsh installation.
 * @returns {Promise<object>} schemastery factory.
 */
async function loadSchema() {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {}
  const require = createRequire(import.meta.url)
  const anchor = process.env.DSH_INSTALL_DIR ?? ''
  const resolved = require.resolve('@deepseek-ai/schemastery', { paths: [anchor] })
  const loaded = require(resolved)
  return loaded.default ?? loaded
}

const z = await loadSchema()

export const Config = z.object({
  appPath: z.string().default('').volatile()
    .description('应用包路径；留空则从运行中的可执行文件自动定位。'),
  autoReapply: z.boolean().default(false).volatile()
    .description('检测到补丁被升级覆盖时自动重打；仍需 ⌘Q 重启才生效。'),
  reapplyNow: z.boolean().default(false).volatile()
    .description('「重新启用」开关：打开后立即打补丁，完成或失败后自动关闭。'),
  revertNow: z.boolean().default(false).volatile()
    .description('「还原」开关：打开后立即还原本插件保存的官方 app.asar，完成或失败后自动关闭。'),
  status: z.string().default('').volatile()
    .description('只读（由插件写回，手改会被下一次刷新覆盖）：最近一次检查或操作的结果。'),
  details: z.string().default('').volatile()
    .description('只读（由插件写回，手改会被下一次刷新覆盖）：存档尺寸、最近一次恢复时间与可回滚备份。'),
})

const BACKUP_SUFFIX = '.window-keeper.bak'

/** One report field list shared by the tool schema and the renderer. */
const REPORT_FIELDS = [
  'state',
  'summary',
  'appVersion',
  'appPath',
  'regionCount',
  'pendingRestart',
  'savedBounds',
  'savedMaximized',
  'savedAt',
  'lastRestore',
  'backup',
  'notes',
  'action',
  'message',
]

/**
 * Render one report as the model-visible content.
 * @param {object} value - validated report.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function renderReport(value) {
  const lines = [
    value.summary,
    `应用：${value.appVersion || '未知版本'}（${value.appPath || '未定位'}）`,
    `补丁注入区：${value.regionCount} 处${value.pendingRestart ? ' · 待重启' : ''}`,
    `上次保存：${value.savedBounds}（最大化：${value.savedMaximized}）${value.savedAt === '无' ? '' : ` · ${value.savedAt}`}`,
    `最近恢复：${value.lastRestore}`,
    `可回滚备份：${value.backup}`,
  ]
  if (value.message !== '') lines.push(`本次操作：${value.message}`)
  if (value.notes !== '') lines.push(`备注：${value.notes}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * @param {object} ctx - plugin context.
 * @param {object} config - live plugin configuration (volatile fields expose `get()`).
 */
export function apply(ctx, config) {
  const scratch = path.join(pluginDataDirectory(), 'tmp')
  /** Real bundle path of the running desktop app; undefined outside an app bundle. */
  const ownBundle = (() => {
    const exec = process.execPath ?? ''
    if (!exec.includes('.app/Contents/MacOS/')) return undefined
    try {
      return fs.realpathSync(path.resolve(exec, '../../..'))
    } catch {
      return undefined
    }
  })()

  /**
   * Refuse to touch any bundle other than the one this Host runs from.
   * The patch rewrites application code, so a misconfigured path must never
   * reach another installed app.
   * @param {string} bundle - bundle path from the report.
   * @returns {string | undefined} refusal message, or undefined when allowed.
   */
  const bundleGuard = bundle => {
    const resolved = (() => {
      try {
        return fs.realpathSync(path.resolve(bundle))
      } catch {
        return path.resolve(bundle)
      }
    })()
    if (ownBundle === undefined) return '拒绝：当前进程不在桌面应用包内，无法安全改写归档'
    if (resolved !== ownBundle) return `拒绝：只能操作运行中的桌面应用（${ownBundle}）`
    return undefined
  }
  /** How long one operation's outcome stays in the status line. */
  const MESSAGE_TTL_MS = 10 * 60 * 1000
  let busy = false
  let timer

  /** The HMR service serializes module and configuration replacement. */
  const hmr = () => {
    try {
      return ctx.get('hmr')
    } catch {
      return undefined
    }
  }

  /**
   * Run configuration work outside an inherited HMR transaction.
   *
   * Plugin activation and module reload run inside the HMR transaction, and that
   * async context stays attached to anything scheduled from it. A configuration
   * write started there is refused as nested, so leave the store first.
   * @param {() => Promise<unknown>} operation - work to run.
   * @returns {Promise<unknown>} operation result.
   */
  const outsideHmr = operation => {
    const storage = hmr()?.executing
    if (storage !== undefined && typeof storage.exit === 'function') return storage.exit(operation)
    return operation()
  }

  /** Append one diagnostic line beside the plugin state (bounded, best effort). */
  const trace = message => {
    try {
      fs.mkdirSync(pluginDataDirectory(), { recursive: true })
      const file = path.join(pluginDataDirectory(), 'debug.log')
      const stat = fs.existsSync(file) ? fs.statSync(file) : undefined
      if (stat !== undefined && stat.size > 64 * 1024) fs.rmSync(file, { force: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch {}
  }

  /** @param {string} field @returns {unknown} live value of an ordinary or volatile field. */
  const read = field => {
    const value = config?.[field]
    return typeof value?.get === 'function' ? value.get() : value
  }

  const report = () => inspectWindowKeeper({
    appPath: read('appPath'),
    execPath: process.execPath,
    state: readState(),
  })

  /**
   * Adopt a patch that exists on disk but has no state entry.
   *
   * Renaming the package, restoring a profile, or installing this plugin after
   * the Python installer all leave a patched archive with an empty state file;
   * without adoption "restore official" would refuse because the backup version
   * is unknown.
   * @param {object} current - inspection report.
   * @returns {{ adopted: boolean, version?: string }} adoption outcome.
   */
  const adoptExistingPatch = current => {
    if (current.state !== 'enabled' || current.appPath === '') return { adopted: false }
    const state = readState()
    if (typeof state.backupVersion === 'string' && state.backupVersion !== '') return { adopted: false }
    const asarPath = path.join(current.appPath, 'Contents', 'Resources', 'app.asar')
    const backupPath = `${asarPath}${BACKUP_SUFFIX}`
    if (!fs.existsSync(backupPath)) return { adopted: false }
    const version = backupVersionFor(backupPath, current.appVersion)
    if (version === undefined) return { adopted: false }
    if (!isBaselineFor(backupPath, asarPath)) return { adopted: false }
    writeState({ backupPath, backupVersion: version, lastResult: 'adopted' })
    trace(`adopted existing patch: ${version}`)
    return { adopted: true, version }
  }

  /**
   * Persist the plugin's own volatile fields without touching the user's patch file.
   * @param {object} patch - fields to merge into this entry's config.
   * @returns {Promise<boolean>} whether the write was accepted.
   */
  const writeConfig = async patch => {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) return false
    try {
      await outsideHmr(() => editor.edit(entry, current => ({ ...current, ...patch })))
      trace(`config write ok: ${JSON.stringify(patch)}`)
      return true
    } catch (error) {
      trace(`config write failed: ${error?.message ?? String(error)}`)
      return false
    }
  }

  /**
   * Apply the main-process patch to the live application bundle.
   * @param {string} reason - what asked for the patch.
   * @returns {{ ok: boolean, message: string }} outcome.
   */
  const patchNow = reason => {
    const current = report()
    if (current.appPath === '') return { ok: false, message: '未找到桌面应用包，无法打补丁' }
    if (current.state === 'enabled') {
      const adoption = adoptExistingPatch(current)
      return {
        ok: true,
        message: adoption.adopted
          ? `补丁已在位（${current.appVersion}），已接管现有备份信息`
          : `补丁已在位（${current.appVersion}），无需重打`,
      }
    }
    if (current.state === 'unpatchable') {
      return { ok: false, message: `无法适配：${current.notes}` }
    }
    const refusal = bundleGuard(current.appPath)
    if (refusal !== undefined) return { ok: false, message: refusal }
    const asarPath = path.join(current.appPath, 'Contents', 'Resources', 'app.asar')
    const backupPath = `${asarPath}${BACKUP_SUFFIX}`
    const state = readState()
    try {
      prepareBackup({
        asarPath,
        backupPath,
        version: current.appVersion,
        previousVersion: state.backupVersion,
      })
      const sizes = installIntoArchive({ asarPath, tempDirectory: scratch })
      // installIntoArchive already proved the staged archive readable by
      // Electron and byte-identical after the rename; Electron caches archives
      // by path, so re-reading the live path here would answer for older bytes.
      const header = readAsarHeader(asarPath)
      writeState({
        appliedAt: new Date().toISOString(),
        appliedVersion: current.appVersion,
        asarSize: header.fileSize,
        backupPath,
        backupVersion: current.appVersion,
        lastResult: `applied:${reason}`,
      })
      return {
        ok: true,
        message: `已为 ${current.appVersion} 打补丁（main.js ${sizes.originalBytes}→${sizes.patchedBytes} 字节），⌘Q 重启后生效`,
      }
    } catch (error) {
      const message = error instanceof PatchError ? error.message : `打补丁失败：${error?.message ?? String(error)}`
      writeState({ lastResult: `apply-failed:${reason}` })
      return { ok: false, message }
    }
  }

  /**
   * Restore the pristine archive this plugin saved.
   * @returns {{ ok: boolean, message: string }} outcome.
   */
  const revertPatch = () => {
    const current = report()
    if (current.appPath === '') return { ok: false, message: '未找到桌面应用包' }
    if (current.state === 'absent') return { ok: true, message: '当前就是官方版本，没有需要还原的补丁' }
    const refusal = bundleGuard(current.appPath)
    if (refusal !== undefined) return { ok: false, message: refusal }
    const asarPath = path.join(current.appPath, 'Contents', 'Resources', 'app.asar')
    const state = readState()
    const backupPath = state.backupPath ?? `${asarPath}${BACKUP_SUFFIX}`
    let backupVersion = state.backupVersion
    if (backupVersion === null || backupVersion === undefined) {
      backupVersion = adoptExistingPatch(current).version ?? backupVersion
    }
    if (backupVersion !== current.appVersion) {
      return { ok: false, message: `备份属于 ${backupVersion ?? '未知版本'}，与当前 ${current.appVersion} 不一致，拒绝还原` }
    }
    if (!isBaselineFor(backupPath, asarPath)) {
      return { ok: false, message: '备份与当前应用包的其他条目不一致，拒绝还原' }
    }
    try {
      revertFromBackup({ asarPath, backupPath, tempDirectory: scratch })
      writeState({ appliedAt: null, appliedVersion: null, lastResult: 'reverted', lastMessage: '已还原官方应用包', lastMessageAt: new Date().toISOString() })
      return { ok: true, message: `已还原官方 ${current.appVersion} 的 app.asar，⌘Q 重启后窗口恢复默认行为` }
    } catch (error) {
      const message = error instanceof PatchError ? error.message : `还原失败：${error?.message ?? String(error)}`
      return { ok: false, message }
    }
  }

  /**
   * Recompute the status line and act on the switch.
   * @param {string} reason - trigger that woke this pass.
   * @returns {Promise<void>} completion.
   */
  const refresh = async (reason, attempt = 0) => {
    if (busy) return
    busy = true
    try {
      let current = report()
      if (current.state === 'enabled') adoptExistingPatch(current)
      if (reason === 'activate') {
        // An operation message belongs to the session that ran it; a fresh
        // activation starts with a clean status line.
        writeState({ lastMessage: null, lastMessageAt: null, lastMessageState: null })
      }
      const switchOn = read('reapplyNow') === true
      const revertOn = read('revertNow') === true
      trace(`refresh(${reason}) state=${current.state} switch=${switchOn} revert=${revertOn} auto=${read('autoReapply') === true}`)
      if (revertOn) {
        const outcome = revertPatch()
        current = report()
        remember(outcome.message, current.state)
        await persist({
          status: line(current, outcome.message),
          details: detailLine(current),
          revertNow: false,
        }, attempt)
        return
      }
      if (switchOn) {
        const outcome = patchNow('switch')
        current = report()
        remember(outcome.message, current.state)
        await persist({
          status: line(current, outcome.message),
          details: detailLine(current),
          reapplyNow: false,
        }, attempt)
        return
      }
      if (current.state === 'absent' && read('autoReapply') === true) {
        const outcome = patchNow('auto')
        current = report()
        remember(outcome.message, current.state)
        await persist({ status: line(current, outcome.message), details: detailLine(current) }, attempt)
        return
      }
      const patch = {}
      const nextStatus = line(current, '')
      const nextDetails = detailLine(current)
      if (read('status') !== nextStatus) patch.status = nextStatus
      if (read('details') !== nextDetails) patch.details = nextDetails
      if (Object.keys(patch).length > 0) await persist(patch, attempt)
    } catch (error) {
      trace(`refresh(${reason}) failed: ${error?.stack ?? String(error)}`)
      await writeConfig({ status: `窗口记忆检查失败：${error?.message ?? String(error)}` })
      scheduleRetry(attempt + 1)
    } finally {
      busy = false
    }
  }

  /**
   * @param {object} current - fresh report.
   * @param {string} message - operation message appended when present.
   * @returns {string} one-line settings status.
   */
  const line = (current, message) => {
    const head = current.appVersion === '' ? current.summary : `${current.summary}（${current.appVersion}）`
    const geometry = current.state === 'enabled' && current.savedBounds !== '暂无存档'
      ? `，存档 ${current.savedBounds.split(' @')[0]}`
      : ''
    let tail = message
    if (tail === '') {
      const stored = readState()
      const at = typeof stored.lastMessageAt === 'string' ? Date.parse(stored.lastMessageAt) : Number.NaN
      if (typeof stored.lastMessage === 'string' && stored.lastMessage !== ''
        && stored.lastMessageState === current.state
        && Number.isFinite(at) && Date.now() - at < MESSAGE_TTL_MS) {
        tail = stored.lastMessage
      }
    }
    const text = `${head}${geometry}${tail === '' ? '' : ` ${tail}`}`
    return text.length <= 240 ? text : `${text.slice(0, 239)}…`
  }

  /**
   * @param {object} current - fresh report.
   * @returns {string} one-line geometry and backup summary.
   */
  const detailLine = current => {
    const parts = []
    if (current.savedBounds !== '暂无存档' && current.savedBounds !== '无') parts.push(`存档 ${current.savedBounds}`)
    if (current.savedMaximized === '是') parts.push('最大化')
    if (current.savedAt !== '无') parts.push(`保存于 ${current.savedAt}`)
    if (current.lastRestore !== '无') parts.push(`最近恢复 ${String(current.lastRestore).split(' ')[0]}`)
    parts.push(`补丁 ${current.regionCount} 处`)
    parts.push(`备份 ${current.backup}`)
    return parts.join(' · ').slice(0, 300)
  }

  /**
   * Keep one operation's outcome visible after the triggering refresh ends.
   * @param {string} message - human-readable result.
   * @param {string} state - report state the message describes.
   */
  const remember = (message, state) => {
    writeState({ lastMessage: message, lastMessageAt: new Date().toISOString(), lastMessageState: state })
  }

  /**
   * Retry a refresh after a failed config write, with a short backoff.
   * The profile's package.json is locked during plugin installation, so the
   * first write after a swap can legitimately time out.
   * @param {number} attempt - retry number, 1-based.
   */
  const scheduleRetry = attempt => {
    if (attempt > 3) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh(`retry${attempt}`, attempt)
    }, 1500 * attempt)
  }

  /**
   * Persist the plugin's fields and schedule a retry when the write is refused.
   * @param {object} patch - fields to merge.
   * @param {number} attempt - current refresh attempt.
   * @returns {Promise<boolean>} whether the write was accepted.
   */
  const persist = async (patch, attempt) => {
    const written = await writeConfig(patch)
    if (!written) scheduleRetry(attempt + 1)
    return written
  }

  const schedule = reason => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh(reason)
    }, 120)
  }

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  })

  ctx.on('loader/volatile-update', () => schedule('switch'))
  ctx.on('settings/document-updated', () => schedule('settings'))

  const initial = setTimeout(() => {
    void refresh('activate')
  }, 50)
  ctx.effect(() => () => clearTimeout(initial))

  const definition = {
    name: 'window_keeper',
    description:
      'Check, apply, or revert DeepSeek Harness Desktop window-size memory. The geometry is saved and restored by '
      + 'an Electron main-process patch inside app.asar; a DSH upgrade replaces that file and silently disables it. '
      + '`status` reports the current state and the saved geometry, `apply` re-installs the patch (a restart is needed '
      + 'afterwards), and `revert` restores the pristine application archive this plugin backed up.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'apply', 'revert'],
          description: 'status reads the state; apply re-installs the patch; revert restores the official bundle.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['enabled', 'absent', 'unpatchable', 'not-found'] },
          summary: { type: 'string' },
          appVersion: { type: 'string' },
          appPath: { type: 'string' },
          regionCount: { type: 'integer' },
          pendingRestart: { type: 'boolean' },
          savedBounds: { type: 'string' },
          savedMaximized: { type: 'string' },
          savedAt: { type: 'string' },
          lastRestore: { type: 'string' },
          backup: { type: 'string' },
          notes: { type: 'string' },
          action: { type: 'string', enum: ['status', 'apply', 'revert'] },
          message: { type: 'string' },
        },
        required: REPORT_FIELDS,
        additionalProperties: false,
      },
      render(_args, value) {
        return renderReport(value)
      },
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const requested = typeof args?.action === 'string' ? args.action : 'status'
      let message = ''
      if (requested === 'apply') message = patchNow('tool').message
      else if (requested === 'revert') message = revertPatch().message
      const current = report()
      if (message !== '') remember(message, current.state)
      if (requested !== 'status') await writeConfig({ status: line(current, message), details: detailLine(current) })
      return { ...current, action: requested, message }
    },
  }

  ctx.effect(() => ctx.tools.register(definition))
}