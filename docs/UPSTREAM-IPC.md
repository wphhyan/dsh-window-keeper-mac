# 上游提案：把窗口几何做成桌面端接口

## 为什么

窗口只能由 Electron 主进程创建，而 DSH 插件运行在 `dsh-desktop-host` 子进程里（`lib/main.js` 用 `spawn` 起 Electron 的 Node 模式子进程），客户端插件只有 `layout / locale / slots / theme` 等服务，preload 暴露的 `dshDesktop` 与 `dshPlatform` 也没有主窗口几何接口。

因此「记住窗口大小」目前只能改 `app.asar` 里的 `lib/main.js`：每次 DSH 升级整体替换该文件，补丁失效；改归档还会破坏代码签名，并依赖 asar 头格式这类非公开契约。上游只要开放一个窗口几何接口，这类插件就能完全退出改归档的行当。

## 建议的最小接口

### 主进程（`lib/main.js`）

```js
// 只服务主窗口；复用 restoreWindowBounds 的同一套校验（有限整数、最小尺寸、workArea 可达性）。
ipcMain.handle('dsh-window:bounds/get', (event) => {
  const window = mainWindow
  if (window === undefined || event.sender !== window.webContents) return undefined
  return { ...window.getNormalBounds(), maximized: window.isMaximized() }
})

ipcMain.handle('dsh-window:bounds/set', (event, bounds) => {
  const window = mainWindow
  if (window === undefined || event.sender !== window.webContents) return false
  const next = restoreWindowBounds(bounds)          // 已存在的校验函数
  if (next === undefined) return false
  window.setBounds(next)
  if (bounds?.maximized === true) window.maximize()
  return true
})
```

事件（可选但很有用）：`resize` / `move` / `maximize` / `unmaximize` / `close` 时向渲染进程发送 `dsh-window:bounds/changed`，带同一份几何。

### preload（`lib/preload-app.cjs`）

```js
contextBridge.exposeInMainWorld('dshDesktop', {
  ...createProductApi(),
  window: {
    getBounds: () => ipcRenderer.invoke('dsh-window:bounds/get'),
    setBounds: (bounds) => ipcRenderer.invoke('dsh-window:bounds/set', bounds),
    onChanged: (listener) => {
      const handle = (_event, bounds) => listener(bounds)
      ipcRenderer.on('dsh-window:bounds/changed', handle)
      return () => ipcRenderer.off('dsh-window:bounds/changed', handle)
    },
  },
})
```

约束与现有代码一致：只接受主窗口 `webContents` 与其主 frame（和 `PLATFORM_IPC` / `DESKTOP_IPC` 的既有校验方式相同），不要允许任意渲染进程改窗口。

### 启动时序

- `setBounds` 在页面加载后调用会产生一次「先默认尺寸、再跳到目标尺寸」的闪动。
- 更干净的做法：主进程在创建窗口前读一个由客户端插件写入的几何文件（或 profile 设置），或在 `ready-to-show` 之前接受一次设置。若上游愿意，另开 `dsh-window:bounds/initial`，在 `createWindow` 前读取，就能完全无闪动。

## 有了这个接口之后

`dsh-window-keeper-mac` 可以退化为纯插件：

1. 客户端半在挂载时 `dshDesktop.window.getBounds()`，把几何写入插件配置（去抖 400ms）。
2. 启动时读回配置并 `setBounds` 一次（异步，允许一次闪动；配合初始几何接口可消除）。
3. 不再需要 asar 补丁、不再需要「重新启用」开关、DSH 升级也不会失效。

## 兼容性

- 桌面端之外的运行环境（Web、源码 headless）没有 `window.dshDesktop.window`，插件应整体 no-op。
- 该接口是纯增量；未升级的插件不受影响。
- 安全面：窗口几何属于非敏感 UI 状态，但仍应限定单窗口、同 frame、同 renderer。

## 验收

- 关窗/退出时插件写入的几何，与下次启动后 `getBounds()` 返回的一致（±1px 取整）。
- 拔掉外接显示器后，`setBounds` 不得把窗口放到所有 workArea 之外（复用现有可达性校验）。
- 最大化状态往返一次后，普通尺寸不被污染（使用 `getNormalBounds`）。