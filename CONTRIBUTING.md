# 参与开发

## 更新日志

GitHub Releases 的**标题与正文一律使用简体中文**：

- 标题形如 `v0.6.1 — 界面本地化与 CI`；
- 正文先给一句总体结论，再按「新增 / 修复 / 变更 / 已知限制」分组列条目；
- 命令、文件路径、包名、API 名、版本号保持原样，不翻译；
- 需要用户手动操作的事项（重启、授权、还原）单独标注；
- 修改历史版本用 `gh release edit <tag> --title ... --notes ...`。

提交信息（commit message）不受此约束，英文即可。

## 测试

```sh
node test/patch.test.mjs
# 走 Electron 自己的 asar 读取器：
ELECTRON_RUN_AS_NODE=1 "<Electron 可执行文件>" test/patch.test.mjs
```

## 改动前请确认

- 补丁只改 `lib/main.js`，其余条目必须逐字节不变；
- 归档开头 16 字节的 pickle 封装四个字段必须原样保留；
- 写出的归档必须能被 Electron 自己的 asar 读取器打开。
