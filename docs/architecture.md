# 项目架构与维护指南

本文档面向维护者，说明 WeChat Claude 的实现结构、各模块职责、数据与配置体系、运行时治理和构建验证流程。使用者和打包细节见 [用户手册](user-exe-guide.md) 与 [打包说明](packaging.md)，微信协议细节见 [微信 iLink Bot API 实战文档](wechat-ilink-api.md)。

## 一、总体架构

```text
微信 iLink Bot API（长轮询）
        |
        v
src/features/02-wechat-connectivity/   轮询、收发、CDN 媒体、加密
        |
        v
src/features/05-message-orchestration/ 去抖合并、正在输入、多气泡
        |
        v
src/features/04-bridge/                桥接：引用解析、图片双模式路由、出站文件
        |
        v
src/features/01-claude-dialogue/       Agent 会话、权限、SQLite、prompt
        |               ^
        v               | 图片提取（直连 HTTP）
src/features/03-file-preprocessing/  vision.ts + markitdown/文本预处理
        |
        v
Claude Agent SDK（内置 claude CLI）── DeepSeek Anthropic 兼容端点
```

入口：

```text
src/runtime/service.ts   正式服务（组装根）
src/cli.ts               CLI 入口
src/electron/main.ts     Electron 托盘入口
```

后端模型通过 Anthropic 兼容端点接 DeepSeek（`ANTHROPIC_BASE_URL`），模型选择在 `config.json`（见四）。

## 二、主要目录

```text
src/features/01-claude-dialogue/       Agent 会话、权限、数据库、prompt 构建
src/features/02-wechat-connectivity/   微信 API、轮询、发送、上传、加密
src/features/03-file-preprocessing/    vision 图片解析 + 文档/文本预处理
src/features/04-bridge/                桥接逻辑、引用、自动发送文件
src/features/05-message-orchestration/ 消息去抖合并（可配置）、正在输入
src/features/06-scheduler/             一次性/每天/每周定时任务
src/features/07-frontend-admin/        本地管理面板（四标签）
src/runtime/                           服务生命周期、配置、日志、存储清理、路径
src/electron/                          托盘菜单、portable 路径修复
scripts/                               setup/启动/打包脚本、preprocess.py、vision-test
docs/                                  文档
```

## 三、核心模块职责

### 3.1 微信连接（02）
长轮询接收、文本/图片/文件/语音发送、CDN 上传下载与 AES 解密。**所有 id 处理注意 JSON 大数陷阱**（见微信 API 文档）：`message_id`/`msg_id` 15 位以上数字在解析前转字符串，入站索引、引用查询、出站 msg_id 三边统一用服务端 id。

### 3.2 图片理解（03 + 04，双模式）
- **直连 direct（默认）**：图片以 image block 内联进主对话（`session.querySimple` 接受 `string | blocks`），对话模型即视觉模型；回复后**异步**提取图片内容写入引用索引和对话记录（多轮记忆回写）。
- **分离 split**：图片先由 `vision.ts` 直连视觉模型提取"描述+转录"文本，注入对话模型上下文。
- 门槛：魔数嗅探真实格式（不信任扩展名）、单图 ≤15MB、单请求 ≤10 张；失败报错不回退。
- PDF/Office 走 markitdown（可选 Python 环境），文本文件内置读取；**OCR 已移除**。
- **扫描版 PDF 视觉回退**：markitdown 对 PDF 附带页数统计（PyMuPDF），每页提取文字 <100 字符即判定扫描版——先给用户微信发送 ETA 提示（"正在视觉识别第 a-b 页，预计约 X 分钟"，按 12 秒/页÷并发估算），再并发渲染+转录前 20 页（`working/pdf_pages/`，`transcribePdfPages` 并发数=visionConcurrency，失败页串行重试一次），按 `[第N页]` 拼接；提示词附续读命令，AI 可自行渲染并 Read 剩余页面（直连模式），或调用 `read_scanned_pdf` 工具（工具批次 ≥5 页同样先发 ETA）。旧版 `.doc/.xls/.ppt` 直接提示转存。
- **文档生成参考资料**：会话工作区初始化时把仓库 `skills/`（minimax-xlsx / pptx-generator / docx，纯文件约 1MB）和 `scripts/preprocess.py`（→ `tools/`）复制进工作区。不走 SDK 的 skills 机制——AI 用已放行的 Read/Bash 直接使用；生成物写入 `working/output_weixin/` 即自动发回。

### 3.3 引用机制（04 + 01）
`message_text_index` 按**用户全局**存储每条消息的解析文本（跨对话可查）。入站消息收信时入库；**出站文本回复发送后也逐气泡入库**（`createWechatSendText` 每气泡回调 → service 层查 `users` 表映射内部 userId → upsert；长回复拆分的每个气泡有自己的服务端 msg_id，引用哪个气泡就解析哪个气泡）——因此引用 AI 自己的回复同样可解析。agent 发出的图片发送后异步提取入库，同样可被引用。引用解析两级：服务端 msg_id 精确匹配 → 失败注入"未能解析"提示（**不吞消息**）。

### 3.4 Agent 会话（01）
每微信会话一个工作区；对话记忆 = 注入最近 6 条历史（每条截 500 字），SDK 每次独立查询（无 resume）。会话对象轻量、模型可热切换（config 变化即重建）、闲置 1 小时淘汰。权限：写入限工作区，Bash 写意图拦截（Windows 无 OS 沙箱）——完整规则见 [Agent 权限模型详解](permissions.md)。

**桥接能力 MCP 工具化（混合协作）**：前置预处理仍是主路径（确定性、零 agent 回合）；`bridge-tools.ts` 用 SDK `createSdkMcpServer` 另提供五个进程内工具供 agent 按需调用——`extract_document`（markitdown）、`render_pdf_pages`（≤20 页/次）、`read_scanned_pdf`（渲染+视觉转录一步返回文本，split 模式可用，vision 不占 agent 回合）、`transcribe_image`、`extract_pdf_images`（抽取 PDF 内嵌原始图表为文件，过滤 <100px 图标/去重/≤40 张）。**所有工具中间文件只落工作区**：渲染页 `working/pdf_pages/`、内嵌图 `working/pdf_images/`；工具名已入权限白名单；扫描版续读指引首选工具、Bash 降级保留。经 Bridge 的 `createMcpServers` 钩子按消息创建（定时任务 runAgent 同样接线）。

**Agent 事件流**：session.ts 消息循环把 query_start / 每轮 assistant_text / assistant_thinking / tool_use / tool_result / result / query_end 推入内存环形缓冲（`events.ts`，500 条，截断消毒，写失败静默）；面板经 `GET /api/agent-events?since=<seq>` 增量拉取。

### 3.5 消息编排（05）
去抖合并窗口可配置（见四）：文本/媒体窗口 + 最大累计上限，来新消息重置计时；命令立即处理；`<<<MSG>>>` 多气泡拆分（≤4 条）。

### 3.6 定时任务（06）
once/daily/weekly；send_text 直发或 agent_prompt 触发 AI；AI 草稿需用户微信确认；错过的任务在服务启动时补跑。

### 3.7 管理面板（07）
四标签：概览（指标/AI 后端状态卡含 token 用量/**Agent 处理流程实时卡**——1 秒增量轮询 SDK 内部逐轮文本/思考/工具调用与结果/用量/存储概览/最近异常，5 秒局部刷新）、对话（会话摘要+懒加载消息+**多选批量删除**）、任务、设置（模式/模型/去抖+报文记录管理）。API：`/api/status|auth|settings|agent-status|agent-events|storage|recent-errors|conversations|sessions/:id/messages|quote-files` 等。

### 3.8 Electron（electron）
托盘常驻、打开面板/数据目录/日志、重启、退出；portable 数据目录用 `PORTABLE_EXECUTABLE_DIR`。

## 四、配置体系

**`.env`（密钥与端点）**：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`。读取顺序：系统环境变量 → exe 旁 `.env` → 数据目录 `.env`。

**`.wechat-claude/config.json`（行为配置，面板可改，即时生效）**：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| imageMode | direct | direct=图片内联主对话；split=先转文字 |
| visionModel | deepseek-v4-flash-vision-exp | 视觉模型（direct 下兼作对话模型） |
| conversationModel | deepseek-v4-flash | split 模式的对话模型 |
| debounceTextMs | 3000 | 文本去抖窗口（ms） |
| debounceMediaMs | 5000 | 媒体去抖窗口 |
| debounceMaxMs | 15000 | 批次累计上限 |
| preprocessMaxChars | 50000 | 单文件提取文本上限（字符），超出截断并告知 AI 路径自行续读 |
| preprocessBatchMaxChars | 150000 | 单批附件提取总量上限（字符），后续文件只留路径 |
| visionConcurrency | 20 | 扫描版逐页视觉转录并发数（实测 20 页全并发约 1 分钟；偶发失败自动串行重试） |
| anthropicBaseUrl / anthropicApiKey / anthropicAuthToken | 未设置 | API 接入覆盖（面板"设置"页可填），**优先于 .env**，保存即生效；密钥不回显，仅显示末 4 位，留空保持不变 |

`.env` 密钥（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`）作为底层默认：系统环境变量 → exe 旁 `.env` → 数据目录 `.env`；上表字段再覆盖其上。服务启动与面板保存时统一应用到运行时（vision 直连与 SDK 子进程环境同步生效）。

**其他环境变量**：`WECHAT_CLAUDE_DATA_DIR`（数据目录）、`WECHAT_CLAUDE_RETENTION_DAYS`（存储保留期，默认 30，0 关闭）、`WECHAT_CLAUDE_LOG_MAX_MB`（日志轮转，默认 5）、`WECHAT_CLAUDE_VISION_TIMEOUT_MS`（提取超时，默认 90s）、`WECHAT_CLAUDE_PYTHON` / `WECHAT_CLAUDE_PREPROCESS_*`（文档解析）、`CLAUDE_SDK_EVENT_LOG=1` / `CLAUDE_PERMISSION_LOG=1`（诊断转储，默认关）。

## 五、数据目录与数据库

```text
.wechat-claude/
├── bot_token.txt            微信登录 token（明文）
├── wechat-qr.png
├── config.json              行为配置（见四）
├── bridge-data/relay.sqlite
└── logs/
    ├── service.log(.1)      按大小轮转
    └── quote/<发送者>.jsonl  每条消息完整原始报文（面板可删）
└── workspaces/session-xxxxxxxx/
    ├── incoming/            收到的媒体解密原件
    ├── skills/              文档生成参考技能（会话创建时从仓库 skills/ 复制）
    ├── tools/preprocess.py  PDF 续读渲染工具（权限层要求脚本在工作区内）
    ├── working/pdf_pages/   扫描版 PDF 渲染的页面 PNG
    ├── working/output_weixin/  待发/已发文件（.sent.json 去重）
    └── output/
```

数据库（sql.js，全库驻内存 + 30 秒快照写盘）：`users / sessions / conversations / message_text_index（永不清） / turns（7 天） / scheduled_tasks(_drafts)`。迁移在 `src/features/01-claude-dialogue/db/migrations/`（001–004）。

**存储治理**：启动时自动清理——turns 留 7 天、关闭会话及工作区目录留 30 天、孤儿目录清扫；数据目录整体搬迁后会话路径自动重映射。

**注意**：Claude CLI 自身会在 `~\.claude\projects\` 留完整问答记录，不受本项目清理管辖。

## 六、依赖

npm 运行依赖：`@anthropic-ai/claude-agent-sdk`（含 win32-x64 CLI 二进制 ~218MB）、`sql.js`、`qrcode`、`zod`（MCP 工具入参 schema）。开发依赖：`typescript`、`tsx`、`electron`、`electron-builder`、`@types/*`。

Python（可选，仅文档解析）：uv 管理，`markitdown[all]` + `pymupdf`（页数统计与扫描版 PDF 渲染；AGPL-3.0，自用无碍，二次分发需自查合规），约 300MB。

仓库 `skills/`（git 跟踪，约 1MB）：minimax-xlsx、pptx-generator、docx 三个文档生成参考技能，会话创建时复制进各工作区，随工作区清理自动回收。

## 七、环境准备与构建

```powershell
npm run setup          # 新机一键：npm install + uv venv + markitdown/pymupdf
                       # 全新机器（无 Node/uv）直接双击 setup.cmd（scripts/setup-machine.ps1）
npm run build:app      # 编译（最低验证门槛）
npm start              # CLI 运行；托盘：npm run electron:dev
npm run dist:win:zip   # 运行版 zip（exe，~187MB）
npm run dist:src:zip   # 源码转移 zip（git 跟踪文件，~200KB）
npm run uninstall      # 清理依赖与构建产物（-All 彻底清理，见 scripts/uninstall.ps1）
```

## 八、验证

没有自动化测试套件（已移除），按以下顺序人工验证：

1. `npm run build:app` 编译通过
2. `npx tsx scripts/vision-test.ts 图片路径 [--extract|--direct]`——离线格式检查 / 视觉提取 / 端到端 blocks
3. `npm start` 冒烟：面板可开、四标签正常、无 token 时扫码流程可用
4. 真机验收清单：普通对话、发图（直连+分离各一）、引用已发图片（跨对话）、定时任务、自动发文件

## 九、启动 / 停止 / 无 token

- CLI：`npm start` 或 `start-wechat-claude.cmd`（包装 start-service.ps1）
- 停止：Ctrl+C 一次优雅退出，二次强制
- 无 token：服务不退出，进入 `waiting_for_login`，面板扫码保存 token 后重启
- service 对外 API：`start() / stop() / waitUntilStopped() / getStatus()`（Electron 直接复用）

## 十、已知限制

- 无自定义图标、无代码签名（SmartScreen 会提示未知发布者）
- Windows 下 agent 无 OS 沙箱，靠权限层限制（写入限工作区、Bash 写意图拦截）
- 对话记忆仅注入最近 6 条文本（未用 SDK resume）；直连模式图片追问依赖异步提取的文本
- 并发=1：一批消息处理期间其他请求排队
- npm audit 对 Electron/builder 生态的提示未处理

## 文档索引

| 文档 | 内容 |
| --- | --- |
| README.md | 项目入口与交接提示 |
| docs/user-exe-guide.md | 使用者手册（exe 运行、面板、迁移、排障） |
| docs/packaging.md | 打包、依赖、运行时配置与维护 |
| docs/wechat-ilink-api.md | 微信协议实战与踩坑（含大数陷阱） |
