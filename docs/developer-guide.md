# 开发指南

面向参与开发、维护或打包的工程师。普通使用请回 [README](../README.md)；exe 使用手册见 [用户版 exe 使用说明](user-exe-guide.md)。

## 仓库现状

- 正式源码在 `src/`，核心业务模块在 `src/features/`。
- 本地数据默认写入程序所在目录旁边的 `.wechat-claude/`，不会提交到 git。
- Windows 便携版通过 `npm run dist:portable` 生成（Tauri 壳 + 内置 Node + 服务代码），产物在 `release/`，不会提交到 git；218MB 的 Claude CLI 不随包分发，首跑安装向导按需下载。

## 开发与打包命令

```powershell
npm start
```

启动正式 CLI 服务。

```powershell
npm run build:app
```

编译正式 app，并复制数据库迁移文件到 `dist/`。

```powershell
npm run tauri:dev
```

编译后启动 Tauri 托盘壳（debug 构建用系统 Node 与仓库根目录，不依赖便携布局）。

```powershell
npm run setup:tauri
```

一次性安装构建壳所需的工具链（VS Build Tools + Rust，幂等可重跑），构建 `src-tauri/` 前必须先跑一次。

```powershell
npm run dist:portable
```

生成 Windows 便携包 zip（`release/WeChatClaude-portable-<版本>.zip`，约 47MB）：组装 Tauri 壳、Node 22 LTS 运行时（构建时下载缓存到 `.tmp/`）、`dist/`、生产依赖（`--omit=dev --omit=optional`，即不含 claude 平台包）、`scripts/` 与 `skills/`。

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
src-tauri/           Tauri 托盘壳（Rust）
src/types/           生产构建需要的补充类型声明
scripts/             正式构建、启动和打包脚本
docs/                使用、架构、权限、打包说明
```

Agent 权限规则（允许/拒绝哪些工具、写入如何限制在工作区、Bash 启发式拦截的边界）详见 [Agent 权限模型详解](permissions.md)。

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

## 维护要点

- 数据库迁移文件在 `src/features/01-claude-dialogue/db/migrations/`。
- 管理后台在 `src/features/07-frontend-admin/admin.ts`：模式/模型/去抖、预处理上限与扫描并发、API 接入与视觉通道独立接入、报文记录管理、Agent 处理流程实时卡。
- 图片解析走 DeepSeek vision（`src/features/03-file-preprocessing/vision.ts`），直连/分离模式与模型名在 `.wechat-claude/config.json`，管理面板可改、即时生效；OCR 已移除。
- PDF/Office 文档解析走可选的 Python markitdown + pymupdf（`scripts/preprocess.py`）；扫描版 PDF 自动逐页视觉识别（上限 20 页，AI 可在工作区自行续读）；图片能力不依赖 Python。
- 文档生成参考技能在仓库 `skills/`（minimax-xlsx / pptx-generator / docx），会话创建时复制进工作区供 AI 用 Read 直接使用，不走 SDK skills 机制。
- 桥接预处理原语已工具化（`claude/bridge-tools.ts`，进程内 MCP）：extract_document / render_pdf_pages / read_scanned_pdf / transcribe_image / extract_pdf_images，agent 可按需调用，扫描版续读首选工具；所有中间文件只落会话工作区。
- Agent 处理实时事件流：`claude/events.ts` 环形缓冲 + 面板概览"Agent 处理流程"卡（`/api/agent-events` 增量拉取）。
- 微信收发 API 在 `src/features/02-wechat-connectivity/wechat/`，参数和踩坑见 [微信 iLink Bot API 实战文档](wechat-ilink-api.md)。
- Claude 权限和工作区限制在 `src/features/01-claude-dialogue/claude/permissions.ts`，完整规则见 [Agent 权限模型详解](permissions.md)。
- 首跑安装向导在 `src/runtime/bootstrap.ts`（下载 claude CLI tgz / 安装 uv+venv，状态机 + `/api/bootstrap`）；Tauri 壳在 `src-tauri/src/main.rs`（进程管理、Job Object 孤儿防护、安装器窗口、托盘）。
- 日志按大小轮转（`WECHAT_CLAUDE_LOG_MAX_MB`），原始报文按发送者记录在 `logs/quote/`；存储保留期由 `WECHAT_CLAUDE_RETENTION_DAYS` 控制。
