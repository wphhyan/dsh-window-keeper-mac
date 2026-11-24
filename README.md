# dsh-window-keeper-mac

**简体中文** | [English](README.en.md)

让 macOS 上的 DSH 桌面版记住主窗口尺寸：下次启动恢复上次关闭时的几何；DSH 升级覆盖应用包后，在设置里点一个开关就能重新启用支持补丁。

![platform](https://img.shields.io/badge/platform-macOS-000000)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1-4B6BFB)
![license](https://img.shields.io/badge/license-MIT-green)

## 为什么需要补丁

DSH 桌面壳创建主窗口时把几何写死、也从不记录，所以每次启动都回到 1280×820。Electron 只允许**主进程**创建和调整窗口，而 DSH 插件运行在 desktop host 子进程里，摸不到 `BrowserWindow`。macOS 上外部进程想改别的应用窗口，需要「辅助功能」授权，插件既无法可靠申请、用户多数也没开过。

所以这个插件做目前唯一无需系统授权的事：在应用壳的 `lib/main.js` 里维护一小段与版本无关的补丁——关闭/退出时记录几何，创建窗口前套用——并负责补丁之外的一切：发现 DSH 升级把它覆盖了、一键重打、校验、保留官方备份、支持一键还原。

## 功能

- **恢复**：每次启动在创建窗口之前应用上次的普通窗口尺寸与最大化标记，不会先弹小窗再跳；移动/缩放/最大化去抖保存，关窗与退出立即落盘。
- **检测**：DSH 升级替换 `app.asar` 后，设置里的状态行会说明补丁已不在（以及上次是哪个版本）。
- **重打**：打开 `reapplyNow` 开关，插件从当前 `lib/main.js` 重建补丁、校验、安装，并提示需要重启。
- **校验**：用 **Electron 自己的 asar 读取器**（不是本插件自己的解析器）复核临时归档；rename 之后再比对整包 SHA-256。
- **还原**：`revertNow` 开关，或工具 `window_keeper` 的 `action: "revert"`，把本插件保存的官方 `app.asar` 放回；备份与当前版本不匹配时拒绝还原。

## 安装

从市场条目安装，或：

```sh
dsh plugin --profile desktop add github:wphhyan/dsh-window-keeper-mac
```

桌面版也可以在 **设置 → 插件 → 添加插件** 里选择本地目录。

## 设置

**设置 → 插件 → 窗口记忆**（独立页签 + 自动生成的配置表单）：

| 字段 | 含义 |
| --- | --- |
| `reapplyNow` | 重新启用开关。打开后立即打补丁，结束（成功或失败）自动复位，结果写入 `status`。 |
| `revertNow` | 还原开关。打开后立即还原官方 `app.asar`，结束后自动复位。 |
| `autoReapply` | 默认关。打开后，启动时若发现补丁缺失会自动重打（仍需重启生效）。 |
| `status` / `details` | 只读：最近一次结果、存档尺寸、最近一次恢复、可回滚备份。 |
| `appPath` | 应用包路径；留空则从运行中的可执行文件自动定位。 |

工具 `window_keeper` 向 agent 提供同样的操作：`status`、`apply`、`revert`。

## 安全性与它改了什么

- 只写 `Contents/Resources/app.asar`，且只在你打开开关时（或 `autoReapply` 打开且补丁缺失时）才写。
- **只允许操作当前运行的这个应用包**：`appPath` 指向别的 Electron 应用时会被拒绝，不会去改别人的安装。
- 首次安装前把当前归档复制为 `app.asar.window-keeper.bak`；别的版本的备份绝不会被用来覆盖新版本。
- 写入走同目录临时归档 → 校验 → 原子 rename；中途崩溃最多留下一个临时文件。
- 安装时校验：`node --check` 语法、注入区恰好 1 处、除 `lib/main.js` 外所有条目逐字节一致、数据区基址不变、Electron 读取器能打开临时归档、rename 后 SHA-256 与暂存文件一致。
- 随时回滚：

  ```sh
  cp "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.window-keeper.bak" \
     "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
  ```

## 限制

- **仅 macOS**。其他平台报告 `not-found`，不做任何写入。
- 修改 `app.asar` 会让应用签名失效。macOS 上应用仍可启动，但可能出现签名告警；DSH 自己的更新器也可能拒绝更新或重新签名——那次更新同样会覆盖补丁，这正是「重新启用」开关存在的理由。本插件不调用 `codesign`。
- 需要对 `/Applications/DeepSeek Harness.app` 的写权限。属于当前用户的安装可以直接写；root 所有的安装需要管理员操作，本插件不做。
- 若将来的 DSH 版本开启 Electron 内嵌 asar 完整性校验，打过补丁的应用将无法启动。升级后先看状态再点开关：插件会拒绝安装 Electron 读不了的归档，但无法改变壳自身的完整性策略。
- 卸载插件不会移除补丁。先还原，再卸载。
- 只记录 primary 窗口；欢迎窗、更新弹窗、内嵌平台视图不记录。
- 崩溃或强杀最多丢失最后 400 ms 的窗口调整。

## 为什么不像 Windows 插件那样用辅助进程

Windows 上的同类插件用一个小辅助进程监视并调整窗口；macOS 不允许这样做（需要辅助功能授权）。主进程补丁是唯一不需要特殊授权的路径，代价是 DSH 升级会覆盖它——所以用「重新启用」开关而不是后台常驻服务。

如果 DSH 桌面壳将来把窗口几何开放给插件，本插件就可以退化为纯插件、不再改应用包。接口提案见 [docs/UPSTREAM-IPC.md](docs/UPSTREAM-IPC.md)。

## 测试

```sh
npm test
```

用合成的小归档验证四个行为：打补丁的确定性、还原字节一致、缺锚点时拒绝、已打过补丁时拒绝重复打。`ELECTRON_RUN_AS_NODE=1 <Electron 可执行文件> test/patch.test.mjs` 会额外走 Electron 自己的 asar 读取器。

## 环境要求

macOS 上的 DSH 桌面版 0.2.2-rc.1 或更新（`engines.dsh`）。只有本地开发才需要 Node 22+。

## 许可

MIT