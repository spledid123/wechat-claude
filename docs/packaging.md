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
- Python：仅当启用 PDF/Office 文档预处理（markitdown）时需要；图片解析走内置 vision 模型，普通聊天和微信收发不需要。

## 图片与文档解析能力

- 图片：`.png .jpg .jpeg .gif .webp` 走 DeepSeek vision 模型（`deepseek-v4-flash-vision-exp`），无需 Python。模式（直连/分离）在 `.wechat-claude/config.json` 配置，管理面板可改。
- 文档：`.pdf .docx .doc .xlsx .xls .pptx .ppt` 走 markitdown（可选 Python 环境）。
- 文本：`.txt .py .js .csv .json .md .log` 等直接读取。
- 失败不阻断主流程，错误会进入 `preprocessingError`。

打包时会把以下文件放进运行资源：

```text
scripts/preprocess.py
scripts/preprocess-requirements.txt
```

目标机器如果需要 PDF/图片解析，推荐在 exe 同目录准备：

```powershell
uv venv .venv
uv pip install -r .\scripts\preprocess-requirements.txt --python .\.venv\Scripts\python.exe
# 没有 uv 时退回传统方式：python -m venv .venv 然后 .\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

也可以通过环境变量或 `.env` 指定其他 Python：

```text
WECHAT_CLAUDE_PYTHON=D:\Tools\wechat-python\.venv\Scripts\python.exe
WECHAT_CLAUDE_PREPROCESS_TIMEOUT_MS=60000
WECHAT_CLAUDE_PREPROCESS_MAX_CHARS=50000
```

vision 图片链路的验证脚本：

```powershell
npx tsx scripts\vision-test.ts .\some-image.png            离线检查（格式/大小/blocks 组装）
npx tsx scripts\vision-test.ts .\some-image.png --extract  调用视觉模型提取描述+文字
npx tsx scripts\vision-test.ts .\some-image.png --direct   端到端：blocks 经 Agent SDK 进主对话
```

迁移给用户时有三种交付方式：

| 方式 | 内容 | 适用场景 |
| --- | --- | --- |
| 全新普通使用 | exe + 可选 `.env` | 不需要历史数据，不需要 PDF/图片解析 |
| 迁移旧数据 | exe + 可选 `.env` + 旧 `.wechat-claude/` | 保留 token、历史、定时任务、工作区 |
| 在线安装解析能力 | exe + 可选 `.env` + `scripts/preprocess-requirements.txt`，目标机运行 `uv venv .venv` 和 `uv pip install -r scripts/preprocess-requirements.txt --python .venv/Scripts/python.exe`（无 uv 时退回 python -m venv + pip） | 目标机可联网，最稳 |
| 指定已有 Python | exe + `.env`，在 `.env` 里设置 `WECHAT_CLAUDE_PYTHON` | 目标机已有统一 Python 环境 |
| 离线拷贝 `.venv` | exe + `.venv/` + `.env` + `.wechat-claude/` | 离线机器；体积大，兼容性需实测 |

.wechat-claude/ 不需要手动空建，程序首次运行会自动创建。只有迁移旧 token、历史对话、定时任务或工作区时才复制旧目录。

不建议把 `.venv` 打进单文件 portable exe。现在 venv 只服务 markitdown（无 PaddleOCR），体积大幅缩小，但仍可能因为 venv 绑定本机 Python 路径而降低可迁移性。

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

## 运行时配置与维护

- `.wechat-claude/config.json`：`imageMode`（direct/split）、`visionModel`、`conversationModel`、消息合并窗口 `debounceTextMs` / `debounceMediaMs` / `debounceMaxMs`（默认 3000/5000/15000，环境变量 `WECHAT_CLAUDE_TEXT_DEBOUNCE_MS` / `WECHAT_CLAUDE_MEDIA_DEBOUNCE_MS` / `WECHAT_CLAUDE_MAX_DEBOUNCE_MS` 可作初始默认值）；管理面板"设置"标签直接读写，对下一条消息生效。
- 管理面板：四标签布局（概览/对话/任务/设置）；概览含 AI 后端状态卡（`GET /api/agent-status`：模式/模型/端点、忙碌/排队、会话模型与轮次、最近 20 次请求的耗时与 token）；对话标签懒加载会话消息（`GET /api/sessions/:id/messages`，每页 50 条）。
- AI 后端统计口径：轮次取 SDK 结果消息的 `num_turns`（权威，含工具调用轮）；token 取结果消息 `usage`（输入/输出/缓存读写完整口径）；内存中的 agent 会话闲置 1 小时自动淘汰。
- 日志：`logs/service.log` 按大小轮转（默认 5MB，`WECHAT_CLAUDE_LOG_MAX_MB`）；每条消息的完整原始报文按发送者记录在 `logs/quote/<发送者>.jsonl`，管理面板可查看和删除。
- 存储清理：启动时自动执行，turns 保留 7 天、过期会话与孤儿工作区目录保留 30 天（`WECHAT_CLAUDE_RETENTION_DAYS`，0 关闭）；引用索引 `message_text_index` 永不清理。
- 数据目录整体搬迁后无需手工修正：会话工作区路径在下次使用时自动重映射到当前目录。
