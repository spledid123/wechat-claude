# 打包说明

当前已完成 Electron 托盘版打包配置。`release/` 是构建产物目录，不提交到 git，需要时用下面的命令重新生成。

普通用户使用 exe 请看 [user-exe-guide.md](user-exe-guide.md)。维护者了解架构和依赖请看 [architecture.md](architecture.md)。

## 产物

```text
release/
├── WeChat Claude 0.1.0.exe
├── win-unpacked/
│   └── WeChat Claude.exe
└── WeChat-Claude-win-unpacked.zip
```

单文件 portable：

```powershell
.\release\"WeChat Claude 0.1.0.exe"
```

可直接运行：

```powershell
.\release\win-unpacked\"WeChat Claude.exe"
```

也可以把 `WeChat-Claude-win-unpacked.zip` 解压到任意目录后运行里面的 `WeChat Claude.exe`。

## 托盘能力

程序启动后不需要终端，会驻留系统托盘。托盘菜单包含：

- 打开管理面板
- 显示状态窗口
- 打开数据目录
- 打开日志文件
- 重启服务
- 退出

打包程序使用同一个正式运行时：

```text
src/runtime/service.ts
```

正式运行时代码在：

```text
src/features/
```

`test/` 仅保留回归测试和历史分阶段测试文档，正式打包不从 `test/features` 引用代码。

## 数据目录

打包后默认数据目录是 exe 所在目录下的：

```text
.wechat-claude/
```

也就是说，如果 exe 位于：

```text
D:\Apps\WeChat Claude\WeChat Claude.exe
```

数据会在：

```text
D:\Apps\WeChat Claude\.wechat-claude\
```

单文件 portable exe 会在启动时先解压到系统临时目录。正式代码不会使用临时解压目录作为数据目录，而是优先读取 electron-builder 提供的 `PORTABLE_EXECUTABLE_DIR`，也就是原始 exe 所在目录。

如果运行后看到数据目录类似：

```text
C:\Users\123\AppData\Local\Temp\<random>\.wechat-claude\
```

说明使用的是修复前的旧 exe，或还没有替换为最新重新打包的产物。请使用重新生成后的：

```text
release\WeChat Claude 0.1.0.exe
```

如果需要保留旧数据，退出程序后把旧临时目录里的 `.wechat-claude` 整个复制到新 exe 所在目录旁边即可。核心数据包括：

- `bot_token.txt`
- `bridge-data\relay.sqlite`
- `workspaces\`
- `logs\`

## 构建命令

编译 app：

```powershell
npm run build:app
```

生成 unpacked 目录：

```powershell
npm run dist:win:dir
```

生成 zip：

```powershell
npm run dist:win:zip
```

尝试生成单文件 portable exe：

```powershell
npm run dist:win
```

注意：`dist:win` 需要 electron-builder 下载 NSIS / winCodeSign 等工具。如果 GitHub 下载失败，可以先使用 `dist:win:zip` 产物。

本机曾成功生成单文件 portable。用到的缓存包括：

```text
C:\Users\123\AppData\Local\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0.7z
```

electron-builder 还会自动下载并缓存 NSIS 相关包，例如 `nsis-3.0.4.1.7z` 和 `nsis-resources-3.4.1.7z`。

## 当前验证

已确认：

- TypeScript app build 通过
- `npm run dist:win` 可生成 `release/WeChat Claude 0.1.0.exe`
- `npm run dist:win:dir` 可生成 `release/win-unpacked/WeChat Claude.exe`
- `npm run dist:win:zip` 可生成 `release/WeChat-Claude-win-unpacked.zip`
- `app.asar` 内包含：
  - `dist/src/electron/main.js`
  - `dist/src/electron/paths.js`
  - 数据库 migrations
  - `@anthropic-ai/claude-agent-sdk`
  - `sql.js`
  - `qrcode`

## 已知限制

- 当前没有自定义 `.ico`，使用 Electron 默认图标。
- 当前没有代码签名。
- 单文件 portable exe 依赖 electron-builder 下载 NSIS 工具；如果网络失败，不影响 `win-unpacked` 和 zip 版本使用。
- npm audit 显示依赖树存在安全提示，主要来自 Electron/builder 生态依赖，后续正式发布前应单独处理。
