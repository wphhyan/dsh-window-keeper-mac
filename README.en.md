# dsh-window-keeper-mac

[简体中文](README.md) | **English**

Remember the DeepSeek Harness desktop window size on macOS: it restores the geometry you left behind on the next launch, and after a DSH upgrade replaces the app bundle, one switch in settings re-applies the support patch.

![platform](https://img.shields.io/badge/platform-macOS-000000)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1-4B6BFB)
![license](https://img.shields.io/badge/license-MIT-green)

## The problem

The DSH desktop shell creates its main window with a hard-coded geometry and never records it, so every launch snaps back to 1280×820. Electron only lets the **main process** create and resize that window, and a DSH plugin runs in the desktop host child process — it cannot reach a `BrowserWindow`. On macOS an external helper cannot resize another application's window without the Accessibility permission, which most users have not granted and which cannot be requested reliably from a plugin.

So this plugin does the only thing that works without system permissions: it keeps a small, version-independent patch in the shell's `lib/main.js` that records the window geometry on close/quit and applies it before the window is created, and it owns everything around that patch — detecting when a DSH upgrade silently removed it, re-applying it, verifying the result, and keeping a pristine backup.

## What it does

- **Restore**: on every launch, the saved normal bounds and maximized flag are applied before the window is created, so there is no "small window first, then jumps" flash. Saves are debounced on move/resize/maximize, and captured immediately on close and quit.
- **Detect**: after a DSH upgrade replaces `app.asar`, the settings status line says the patch is gone (and from which version it disappeared).
- **Re-apply**: turn on `reapplyNow` in Settings → Plugins → Window memory. The patch is rebuilt from the live `lib/main.js`, verified, installed, and the status says a restart is needed.
- **Verify**: the rebuilt archive is read back with **Electron's own asar reader** (not the plugin's parser), and after the rename its SHA-256 is compared with the staged file.
- **Revert**: `revertNow`, or the `window_keeper` tool with `action: "revert"`, restores the pristine `app.asar` this plugin saved. Restores are refused when the backup no longer matches the running version.

## Install

From the plugin market entry, or from this repository:

```sh
dsh plugin --profile desktop add github:wphhyan/dsh-window-keeper-mac
```

The desktop app also accepts a local directory through **Settings → Plugins → Add plugin**.

## Settings

**Settings → Plugins → Window memory** (a tab of its own, plus the automatic config form):

| Field | Meaning |
| --- | --- |
| `reapplyNow` | Re-enable switch. Applies the patch immediately; resets itself afterwards and writes the outcome to `status`. |
| `revertNow` | Restore switch. Restores the saved pristine `app.asar`; resets itself. |
| `autoReapply` | Off by default. When on, a launch that finds the patch missing re-applies it automatically (a restart is still needed). |
| `status` / `details` | Read-only outcome line and geometry summary (saved bounds, last restore, backup). |
| `appPath` | Bundle path; empty means autodetect from the running executable. |

The `window_keeper` tool offers the same operations to the agent: `status`, `apply`, `revert`.

## Safety and what it changes

- It writes **only** `Contents/Resources/app.asar`, and only when you turn a switch on, or when `autoReapply` is on and the patch is missing.
- **Only the bundle this app currently runs from can be patched**: an `appPath` pointing at another Electron app is refused, so the plugin cannot modify a different installation.
- Before the first install it copies the current archive to `app.asar.window-keeper.bak`. A backup from another version is never used to overwrite a newer build.
- The write goes to a sibling staging archive, is verified, and is then renamed into place atomically. A crash leaves at most a stray staging file.
- Verified on install: `node --check` syntax, exactly one patch region, every other archive entry byte-identical, payload base unchanged, Electron's reader opens the staged archive, and the post-rename SHA-256 matches.
- Rollback at any time:

  ```sh
  cp "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.window-keeper.bak" \
     "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
  ```

## Limitations

- **macOS only.** On other platforms the plugin reports `not-found` and does nothing.
- Modifying `app.asar` invalidates the application's code signature. The app still launches on macOS, but macOS may show a signature warning, and DSH's own updater may refuse or re-sign the bundle on the next update — that update also removes the patch, which is what the re-enable switch is for. This plugin does not call `codesign`.
- Requires write permission on `/Applications/DeepSeek Harness.app`. A per-machine install owned by the user works; a root-owned installation needs an administrative action the plugin does not perform.
- If a future DSH release turns on Electron's embedded asar integrity validation, a patched bundle will not start. Check the status before enabling the switch after an upgrade; the plugin refuses to install an archive Electron cannot read, but it cannot change the shell's own integrity policy.
- Uninstalling the plugin does not remove the patch. Revert first, then uninstall.
- The patch only records the primary window; the welcome window, update dialog, and embedded platform views are not tracked.
- A crash or `kill -9` can lose at most the last 400 ms of window adjustments.

## Why not a helper process?

Windows plugins in this space watch and resize the window from a small helper process. macOS does not allow that without Accessibility permission, so the main-process patch is the only route that needs no special permission. The trade-off: a DSH upgrade replaces the file, hence the re-enable switch instead of a background service.

See [docs/UPSTREAM-IPC.md](docs/UPSTREAM-IPC.md) for the desktop API this plugin would use if the shell ever exposes window geometry to plugins — then the patch would no longer be needed.

## Tests

```sh
npm test
```

Four checks on synthetic archives: deterministic patch output, byte-identical revert, refusal without the expected anchors, and refusal when a patch is already present. Running `ELECTRON_RUN_AS_NODE=1 <electron> test/patch.test.mjs` additionally exercises Electron's own asar reader.

## Requirements

DSH Desktop for macOS, 0.2.2-rc.1 or newer (`engines.dsh`). Node 22+ is only needed for local development.

## License

MIT