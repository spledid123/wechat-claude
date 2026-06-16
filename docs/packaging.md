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

## 运行机依赖边界

最终用户只运行 exe 时，不需要安装：

- Node.js / npm。
- 项目 `node_modules/`。
- Claude Code SDK / Claude Agent SDK npm 包。
- 项目 `.venv/`。
- 开发目录 `.claude/`。
- 源码目录 `src/`、`test/`、`scripts/`。

portable exe 已包含 Electron/Node 运行时、编译后的应用代码、`@anthropic-ai/claude-agent-sdk`、Windows x64 的 `claude.exe`、`sql.js`、`qrcode` 和数据库迁移文件。

可能仍需要外部提供：

- Claude/DeepSeek/Anthropic 认证配置：系统环境变量、exe 同目录 `.env` 或 `.wechat-claude\.env`。
- 网络：微信 iLink Bot API 和模型 API。
- Python：仅当启用 PDF/图片/Office 预处理能力时需要；普通聊天和微信收发不需要。

## PDF / 图片解析能力

正式预处理能力按 `test/features/03-file-preprocessing/README.md` 验收：

- 图片：`.png .jpg .jpeg .gif .bmp .webp` 走 PaddleOCR。
- 文档：`.pdf .docx .doc .xlsx .xls .pptx .ppt` 走 markitdown。
- 文本：`.txt .py .js .csv .json .md .log` 等直接读取。
- 失败不阻断主流程，错误会进入 `preprocessingError`。

打包时会把以下文件放进运行资源：

```text
scripts/preprocess.py
scripts/preprocess-requirements.txt
```

目标机器如果需要 PDF/图片解析，推荐在 exe 同目录准备：

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

也可以通过环境变量或 `.env` 指定其他 Python：

```text
WECHAT_CLAUDE_PYTHON=D:\Tools\wechat-python\.venv\Scripts\python.exe
WECHAT_CLAUDE_PREPROCESS_TIMEOUT_MS=60000
WECHAT_CLAUDE_PREPROCESS_MAX_CHARS=50000
```

本机用 `test/pic` 完整验证过：

```powershell
node_modules\.bin\tsx.cmd scripts\preprocess-test.ts
```

验证结果覆盖 PDF、PNG、JPG、DOCX、XLSX 和文本样本，均能输出 `OK`。

迁移给用户时有三种交付方式：

| 方式 | 内容 | 适用场景 |
| --- | --- | --- |
| 全新普通使用 | exe + 可选 `.env` | 不需要历史数据，不需要 PDF/图片解析 |
| 迁移旧数据 | exe + 可选 `.env` + 旧 `.wechat-claude/` | 保留 token、历史、定时任务、工作区 |
| 在线安装解析能力 | exe + 可选 `.env` + `scripts/preprocess-requirements.txt`，目标机运行 `python -m venv .venv` 和 `pip install -r scripts/preprocess-requirements.txt` | 目标机可联网，最稳 |
| 指定已有 Python | exe + `.env`，在 `.env` 里设置 `WECHAT_CLAUDE_PYTHON` | 目标机已有统一 Python 环境 |
| 离线拷贝 `.venv` | exe + `.venv/` + `.env` + `.wechat-claude/` | 离线机器；体积大，兼容性需实测 |

.wechat-claude/ 不需要手动空建，程序首次运行会自动创建。只有迁移旧 token、历史对话、定时任务或工作区时才复制旧目录。

不建议把 `.venv` 打进单文件 portable exe。当前本机 `.venv` 约 1.7GB，且 PaddleOCR 模型缓存可能在用户目录；直接打包会让产物巨大，并可能因为 venv 绑定本机 Python 路径而降低可迁移性。

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

## Claude SDK 配置

exe 不内置任何 Claude/DeepSeek 密钥，也不依赖迁移开发目录中的 `.claude/`。

运行时会按顺序读取：

1. 系统环境变量。
2. exe 同目录的 `.env`。
3. 数据目录里的 `.wechat-claude\.env`。

`.env` 示例：

```text
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
```

如果目标机器已经配置了系统环境变量，则不需要额外文件。若需要迁移，只复制 exe、`.wechat-claude/` 和可选 `.env` 即可。

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
