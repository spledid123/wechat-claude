# WeChat Claude

[English](README.en.md) | 简体中文

WeChat Claude 是一个本地运行的微信 Claude 桥接程序。它把微信消息交给 Claude Agent 处理，再把回复、生成文件或定时任务结果发回微信；正式版本通过 Electron 托盘运行，并提供本地管理面板。

这份 README 面向使用者和访客。普通使用者请看 [用户版 exe 使用说明](docs/user-exe-guide.md)；参与开发与维护请看 [开发指南](docs/developer-guide.md)；架构细节请看 [项目架构与打包说明](docs/architecture.md)；微信接口细节请看 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。

> 本项目代码主要由 AI 辅助完成：主力模型为 **GLM-5.3**，早期部分提交由 Claude 协助（见 Contributors）。

## 功能特性

- **微信 ↔ Claude Agent 双向桥接**：扫码登录，token 本地持久化；文本、语音（自动转写）、图片、文件、引用消息都能处理。
- **完整智能体而非纯聊天模型**：基于 Claude Agent SDK，支持工具调用与按会话隔离的工作区。
- **权限硬边界**：微信场景无人值守，权限层把一切写入限制在该会话的独立工作区内，破坏性/不可逆命令与人机交互类工具直接拒绝；读文件、搜索、联网检索全程放行。拒绝原因会返回给 AI，它会自行换安全路径重试，对话不中断。完整规则见 [Agent 权限模型详解](docs/permissions.md)。
- **多用户独立会话**：按微信发送者隔离，各自拥有独立上下文与工作区。
- **消息合并窗口**：连续发的多条消息自动合并为一次 AI 请求，避免"一句话拆几条、AI 抢答第一条"——文本消息间隔 3 秒、图片/文件等媒体间隔 5 秒内到达的并入同批，消息源源不断时累计等待最长 15 秒封顶后强制处理；三个窗口都可在管理面板"设置"页或环境变量中调整。
- **图片理解**：视觉通道（默认 DeepSeek vision），支持直连/分离模式，可与主对话使用不同供应商和密钥。
- **文档解析**：PDF / Office 文档文本提取（markitdown + pymupdf）；扫描版 PDF 自动逐页视觉转录（默认上限 20 页，AI 可在工作区续读）。
- **文档生成**：内置 docx / xlsx / pptx 生成技能，产物自动发回微信。
- **定时任务**：自然语言创建，草稿确认制，到点自动执行并把结果发回微信。
- **引用上下文**：引用你或 AI 的历史消息继续对话，被引内容可见。
- **本地管理面板**：浏览器里配置模式/模型/API 接入与视觉通道、管理历史会话、查看按发送者拆分的报文记录与 Agent 处理流程实时事件流。
- **数据全本地**：SQLite 存储、日志按大小轮转、保留期可配置；Electron 托盘常驻 + Windows 单文件 portable exe。

## 环境要求与一键安装

| 项目 | 要求 | 安装方式 |
| --- | --- | --- |
| 操作系统 | Windows 10（1709+）/ Windows 11，x64 | — |
| Node.js | ≥ 20，推荐 22 LTS | `winget install OpenJS.NodeJS.LTS`，或 [nodejs.org/zh-cn](https://nodejs.org/zh-cn) 下载 LTS x64 安装包；`node -v` 验证 |
| uv | 任意近期版本 | `winget install astral-sh.uv`，或 PowerShell 执行 `irm https://astral.sh/uv/install.ps1 \| iex` |
| Python | 无需手动安装 | 由 uv 自动下载托管版 CPython 并建入项目 `.venv` |
| 磁盘 | 约 700MB | node_modules ≈400MB（含 Claude CLI 二进制）+ .venv ≈300MB（markitdown + pymupdf） |

说明：

- winget 在 Windows 10 1709+ 一般自带；没有时可从微软商店安装"应用安装程序"，或按上表用官网安装包替代。
- **一键安装：双击 `setup.cmd`**（或在项目目录运行 `powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1`）。脚本会检查并补装缺失的 Node.js / uv（经 winget），创建 `.env`（从 `.env.example` 复制，需自行填入密钥），然后安装全部依赖。**幂等可重跑**，中断后重新双击即从断点续上。
- 机器上已有 Node.js 和 uv 时，`npm run setup` 等效（跳过系统组件检测）。
- macOS / Linux：核心服务代码平台中立，但安装/启动/打包脚本（PowerShell/cmd）与 Python 路径探测（`.venv\Scripts\python.exe`）均为 Windows 设计，当前**不作正式支持**。强行运行需：自行 `npm install`、手动创建 venv 并设置 `WECHAT_CLAUDE_PYTHON` 指向 `.venv/bin/python`、直接 `npx tsx src/cli.ts` 启动。

**一键卸载**：双击 `uninstall.cmd`（或 `npm run uninstall`）。默认只清理依赖与构建产物（node_modules / .venv / dist / .tmp），源码、`.env` 密钥与微信数据不受影响，重跑 `setup.cmd` 可完全恢复。可选参数：

| 参数 | 作用 |
| --- | --- |
| `-RemoveData` | 额外删除 `.wechat-claude\`（微信 token、对话数据库、工作区，不可恢复，会二次确认） |
| `-RemoveEnv` | 额外删除 `.env`（会二次确认） |
| `-All` | 以上全部 + `release\` 打包产物 |
| `-Yes` | 跳过二次确认（供脚本调用） |

## 快速开始

```powershell
npm run setup
npm run build:app
npm start
```

`npm run setup` 一键安装全部依赖：Node 包（`npm install`，含打包工具链）+ Python 预处理环境（uv 管理，markitdown + pymupdf，约 300MB；机器上没有 uv 时自动跳过并给出提示——不影响图片理解与普通聊天，仅 PDF/Office/扫描版解析不可用）。也可以只跑 `npm install` 不装 Python。全新机器（连 Node.js 都没有）直接双击 `setup.cmd`，见上面的"环境要求与一键安装"。

启动后会打印本地管理面板地址，默认类似：

```text
Admin panel : http://127.0.0.1:8787/
Data dir    : D:\path\to\project\.wechat-claude
```

如果还没有微信 token，服务不会退出；打开管理面板刷新二维码、扫码确认并保存 token，然后重启服务。

## 微信聊天指令

在微信对话里直接发送即可：

| 指令 | 作用 |
| --- | --- |
| `/new` | 新建会话 |
| `/list` | 列出历史会话 |
| `/switch <序号>` | 切换到指定会话 |
| `/stop` | 强制结束当前正在处理的 AI 任务（直接发"停止"或"终止"等效） |
| `/tasks` | 列出定时任务 |
| `/task-del <序号或ID>` | 删除定时任务 |
| `确认` / `取消` | 确认或放弃定时任务草稿 |
| `/help` | 查看帮助 |

定时任务通过自然语言创建：AI 先生成待确认草稿，回复"确认"后才会真正创建。

## 环境变量

除 `.env` 三项（见 [.env.example](.env.example)）外，其余均有合理默认，按需覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | 官方端点 | Anthropic 兼容端点（如 DeepSeek 中转） |
| `ANTHROPIC_API_KEY` | — | API Key（x-api-key 头） |
| `ANTHROPIC_AUTH_TOKEN` | — | Auth Token（Bearer 头，与上二选一） |
| `WECHAT_CLAUDE_DATA_DIR` | 程序旁 `.wechat-claude/` | 数据目录位置 |
| `WECHAT_CLAUDE_PYTHON` | 自动探测 `.venv` | Python 解释器路径（文档预处理用） |
| `WECHAT_CLAUDE_PREPROCESS_SCRIPT` | 内置 `scripts/preprocess.py` | 预处理脚本路径 |
| `WECHAT_CLAUDE_PREPROCESS_MAX_CHARS` | 50000 | 单文件提取字符上限 |
| `WECHAT_CLAUDE_PREPROCESS_TIMEOUT_MS` | 60000 | 单文件预处理超时（毫秒） |
| `WECHAT_CLAUDE_TEXT_DEBOUNCE_MS` | 3000 | 文本消息合并窗口（毫秒） |
| `WECHAT_CLAUDE_MEDIA_DEBOUNCE_MS` | 5000 | 媒体消息合并窗口（毫秒） |
| `WECHAT_CLAUDE_MAX_DEBOUNCE_MS` | 15000 | 消息合并最大累计时长（毫秒） |
| `WECHAT_CLAUDE_VISION_TIMEOUT_MS` | 90000 | 视觉请求超时（毫秒） |
| `WECHAT_CLAUDE_LOG_MAX_MB` | 5 | 单个日志文件大小上限（MB，超限轮转） |
| `WECHAT_CLAUDE_RETENTION_DAYS` | 30 | 数据保留天数（0 = 永不清理） |

## 许可证

[MIT](LICENSE)
