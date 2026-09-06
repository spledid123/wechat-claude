# WeChat Claude

[English](README.en.md) | 简体中文

WeChat Claude 是一个本地运行的微信 Claude 桥接程序。它把微信消息交给 Claude Agent 处理，再把回复、生成文件或定时任务结果发回微信；正式版本通过 Electron 托盘运行，并提供本地管理面板。

这份 README 面向接手项目的人类工程师。普通使用者请看 [用户版 exe 使用说明](docs/user-exe-guide.md)，架构细节请看 [项目架构与打包说明](docs/architecture.md)，微信接口细节请看 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。

> 本项目代码主要由 AI 辅助完成：主力模型为 **GLM-5.3**，早期部分提交由 Claude 协助（见 Contributors）。

## 当前状态

- 正式源码在 `src/`，核心业务模块在 `src/features/`。
- 本地数据默认写入程序所在目录旁边的 `.wechat-claude/`，不会提交到 git。
- Windows portable exe 通过 `electron-builder` 生成，产物在 `release/`，不会提交到 git。

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

## 常用命令

```powershell
npm start
```

启动正式 CLI 服务。

```powershell
npm run build:app
```

编译正式 app，并复制数据库迁移文件到 `dist/`。

```powershell
npm run electron:dev
```

编译后用 Electron 启动托盘程序。

```powershell
npm run dist:win
```

生成 Windows 单文件 portable exe。

```powershell
npm run dist:win:dir
```

生成 `release/win-unpacked/` 目录版。

```powershell
npm run dist:win:zip
```

生成目录版并压缩为 zip。

## 类型检查

```powershell
npm run build:app
```

测试套件已移除（旧套件验证的是 `test/features` 中的历史代码拷贝，而非 `src/` 真实代码，参考价值有限；历史版本可从 git 记录找回）。改动后至少跑一次上面的编译命令确认类型无误。

## 目录结构

```text
src/                 正式源码
src/features/        微信连接、Claude 会话、桥接、文件处理、调度器、管理后台
src/runtime/         正式服务运行时
src/electron/        Electron 托盘入口
src/types/           生产构建需要的补充类型声明
scripts/             正式构建、启动和打包脚本
docs/                使用、架构、权限、打包说明
```

Agent 权限规则（允许/拒绝哪些工具、写入如何限制在工作区、Bash 启发式拦截的边界）详见 [Agent 权限模型详解](docs/permissions.md)。

## 本地数据和忽略规则

以下目录/文件是本地运行或构建产物，已在 `.gitignore` 中忽略：

```text
.wechat-claude/
.tmp/
dist/
release/
node_modules/
.env
.claude/
test_output.json
```

不要把 token、SQLite 数据库、工作区、日志、打包产物提交到 git。

## 交接提示

- 数据库迁移文件在 `src/features/01-claude-dialogue/db/migrations/`。
- 管理后台在 `src/features/07-frontend-admin/admin.ts`：模式/模型/去抖、预处理上限与扫描并发、API 接入与视觉通道独立接入、报文记录管理、Agent 处理流程实时卡。
- 图片解析走 DeepSeek vision（`src/features/03-file-preprocessing/vision.ts`），直连/分离模式与模型名在 `.wechat-claude/config.json`，管理面板可改、即时生效；OCR 已移除。
- PDF/Office 文档解析走可选的 Python markitdown + pymupdf（`scripts/preprocess.py`）；扫描版 PDF 自动逐页视觉识别（上限 20 页，AI 可在工作区自行续读）；图片能力不依赖 Python。
- 文档生成参考技能在仓库 `skills/`（minimax-xlsx / pptx-generator / docx），会话创建时复制进工作区供 AI 用 Read 直接使用，不走 SDK skills 机制。
- 桥接预处理原语已工具化（`claude/bridge-tools.ts`，进程内 MCP）：extract_document / render_pdf_pages / read_scanned_pdf / transcribe_image / extract_pdf_images，agent 可按需调用，扫描版续读首选工具；所有中间文件只落会话工作区。
- Agent 处理实时事件流：`claude/events.ts` 环形缓冲 + 面板概览"Agent 处理流程"卡（`/api/agent-events` 增量拉取）。
- 微信收发 API 在 `src/features/02-wechat-connectivity/wechat/`，参数和踩坑见 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。
- Claude 权限和工作区限制在 `src/features/01-claude-dialogue/claude/permissions.ts`，完整规则见 [Agent 权限模型详解](docs/permissions.md)。
- Electron portable 数据目录修复逻辑在 `src/electron/paths.ts`。
- 日志按大小轮转（`WECHAT_CLAUDE_LOG_MAX_MB`），原始报文按发送者记录在 `logs/quote/`；存储保留期由 `WECHAT_CLAUDE_RETENTION_DAYS` 控制。
