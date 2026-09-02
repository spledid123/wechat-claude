# WeChat Claude exe 使用说明

这份文档面向只使用 exe 的用户，不需要了解源码。

## 你需要什么

- Windows 10/11 x64。
- 一个可用的微信机器人登录二维码。
- 可访问微信 iLink Bot API 的网络。
- 可用的 Claude Agent SDK 运行环境。当前 exe 已包含项目依赖和 Claude SDK 包，但 Claude 账号/认证仍依赖本机环境中 Claude SDK 的可用状态。

如果程序能启动但 AI 回复失败，优先检查本机 Claude/Anthropic 登录或网络环境。

## exe 不需要安装什么

只运行打包好的 exe 时（要求 Windows 10 1709+ / Windows 11 x64），不需要安装或复制：

- Node.js。
- npm。
- 项目里的 `node_modules/`。
- Claude Code SDK / Claude Agent SDK npm 包。
- 项目里的 Python `.venv/`。
- 开发目录里的 `.claude/`。
- `src/`、`test/`、`scripts/` 等源码目录。

exe 已经内置 Electron/Node 运行时、项目编译后的 JavaScript、`@anthropic-ai/claude-agent-sdk`、Windows x64 的 `claude.exe`、`sql.js` 和 `qrcode`。

Python 不是基础运行依赖。普通聊天、微信收发、定时任务、自动发送已有文件、**图片理解（vision）**都不需要 Python。只有当你需要 Office/PDF/表格等文档预处理能力时，才需要额外安装 Python 和对应工具链。

## 图片理解（vision，无需 Python）

图片默认由 DeepSeek 视觉模型（`deepseek-v4-flash-vision-exp`）解析，支持 JPG/PNG/GIF/WebP（单图 15MB 以内），不需要安装任何额外环境。管理面板"设置"标签里可以切换两种模式：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| 直连 direct（默认） | 图片直接进入主对话，AI 亲眼看图；对话模型即视觉模型 | 看图聊天、图表、截图提问 |
| 分离 split | 图片先由视觉模型转成"描述+文字转录"文本，再交给对话模型（如 deepseek-v4-flash） | 想让日常对话用更便宜的纯文本模型 |

设置保存在 `.wechat-claude\config.json`，保存后对下一条消息立即生效，无需重启。直连模式下，回复发出的同时程序会在后台异步把图片内容存成文字记录，保证后续追问和"引用这张图片"仍然可用。

BMP 格式暂不支持视觉解析（会提示转换后重发）；图片解析失败不回退本地 OCR，会把原因告知 AI 和用户。

## PDF / Office 文档解析依赖（可选）

如果你要让程序读取 PDF、Word、Excel、PPT 内容，需要准备 Python 预处理环境（markitdown + pymupdf，无需 PaddleOCR）：

| 文件类型 | 工具 | 说明 |
| --- | --- | --- |
| `.png .jpg .jpeg .gif .webp` | DeepSeek vision（内置） | 不需要 Python |
| `.pdf .docx .xlsx .pptx` | markitdown + pymupdf | 转 Markdown 文本；扫描版 PDF 自动逐页视觉识别（上限 20 页/批，**识别前会先发微信提示预计耗时**，并发加速约 1 分钟/批） |
| `.epub .msg .zip` | markitdown | 电子书 / Outlook 邮件 / 压缩包内容 |
| `.doc .xls .ppt` | 不支持 | 旧版二进制格式，请另存为 `.docx/.xlsx/.pptx` 或 PDF 后重发 |
| `.txt .py .js .csv .json .md .log` 等 | 内置读取 | 不需要 Python |

单个文件提取超过上限（默认 5 万字符，面板"设置"可调）会截断，AI 会拿到完整文件路径、可自行继续读取；一批消息的附件总量也有独立上限（默认 15 万字符）。

推荐在 exe 同目录创建 `.venv`：

```powershell
cd "D:\Apps\WeChat Claude"
uv venv .venv
uv pip install -r .\scripts\preprocess-requirements.txt --python .\.venv\Scripts\python.exe
# 没有 uv 时退回传统方式：python -m venv .venv 然后 .\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

如果你不想把 `.venv` 放在 exe 同目录，也可以在 `.env` 中指定 Python：

```text
WECHAT_CLAUDE_PYTHON=D:\Tools\wechat-python\.venv\Scripts\python.exe
```

新版 exe 会把 `scripts\preprocess.py` 和 `scripts\preprocess-requirements.txt` 作为运行资源带上。文档解析通常几秒内完成。

手动验证命令：

```powershell
.\.venv\Scripts\python .\scripts\preprocess.py --mode markitdown --file .\some-file.pdf
```

成功时会输出 JSON，例如：

```json
{"ok": true, "text": "提取到的文字...", "truncated": false}
```

对 PDF 会额外返回页数信息（`pages`、`chars_per_page`），每页文字量异常少时程序判定为扫描版，自动用 PyMuPDF 渲染成图片再逐页走视觉识别。渲染也可以手动调用：

```powershell
.\.venv\Scripts\python .\scripts\preprocess.py --mode pdf-pages --file .\scan.pdf --out-dir .\pages --start 1 --max-pages 20
```

> PyMuPDF 采用 AGPL-3.0 许可。本程序自用不分发修改后的 PyMuPDF 本身；若你二次分发打包产物，请自行确认许可合规。

## Claude / DeepSeek 配置

不建议把密钥打进 exe，也不需要迁移开发目录里的 `.claude/`。

正式 exe 启动时会按顺序读取：

1. 系统环境变量。
2. exe 同目录的 `.env`。
3. 数据目录里的 `.wechat-claude\.env`。

后面的 `.env` 不会覆盖已经存在的系统环境变量。

如果你使用 Anthropic 兼容接口，可以在 exe 同目录创建 `.env`：

```text
ANTHROPIC_API_KEY=你的key
ANTHROPIC_AUTH_TOKEN=你的token
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
```

`.env` 含密钥，不要发给别人，也不要提交到 git。

## 推荐放置方式

把 exe 放进一个固定文件夹，例如：

```text
D:\Apps\WeChat Claude\WeChat Claude 0.1.0.exe
```

首次运行后，程序会在 exe 所在目录旁边创建：

```text
D:\Apps\WeChat Claude\.wechat-claude\
```

这个目录就是你的数据目录，包含：

- `bot_token.txt`：微信登录 token。
- `bridge-data\relay.sqlite`：会话、消息、定时任务数据库。
- `workspaces\`：每个微信会话的工作区。
- `logs\`：运行日志。
- `wechat-qr.png`：登录二维码图片。

不要只迁移 exe 而忘记 `.wechat-claude/`，否则历史会话、token 和定时任务都会丢失。

## 启动和托盘

双击 exe 后，程序会常驻系统托盘。托盘菜单包含：

- 打开管理面板。
- 显示状态窗口。
- 打开数据目录。
- 打开日志文件。
- 重启服务。
- 退出。

如果双击后没有看到窗口，这是正常的；请看 Windows 右下角托盘图标。

## 首次登录微信

1. 启动 exe。
2. 在托盘菜单点击“打开管理面板”。
3. 点击“刷新二维码”。
4. 用微信扫码并确认。
5. 点击“轮询扫码状态”。
6. 页面提示 token 已保存后，在托盘菜单点击“重启服务”。

保存 token 后需要重启服务，因为当前运行中的微信收发连接不会热替换 token。

## 管理面板能做什么

管理面板默认在本机地址：

```text
http://127.0.0.1:8787/
```

页面分为四个标签：

**概览**
- 程序是否运行、本地时间、数据目录等真实路径。
- token 和二维码状态。
- AI 后端状态卡：当前图片模式/模型/对接端点、忙碌与排队数、各会话使用的模型与处理状态（绿点）、最近请求的耗时/轮次/输入输出 token（每 5 秒自动刷新；轮次来自 SDK 结果消息的权威计数，含工具调用轮；最近请求最多保留 20 条）。
- Agent 处理流程卡（实时）：AI 处理消息时逐轮显示内部流程——开始/每轮回复文本/思考（若模型返回）/工具调用与结果/完成统计（轮数、耗时、token、权限拒绝），每秒增量刷新，最新在上。
- 存储概览卡：数据目录占用（工作区/日志/数据库）、会话数与自动清理策略、引用索引条数。
- 最近异常卡：日志里最近的 ERROR/WARN 摘要（排障入口）。

**对话**
- 最近 20 个会话列表（支持按用户/ID/摘要过滤），默认收起，点击"展开"加载该会话最近 50 条消息，可"加载更早消息"翻页。
- 支持**多选删除**：勾选多个会话（或"全选"当前过滤结果）后点"删除选中"，批量删除会话及其工作目录。

**任务**
- 创建、删除一次性/每天/每周定时任务。

**设置**
- 切换图片模式（直连/分离）、修改视觉/对话模型名、调整消息合并窗口（文本/媒体/最大累计，毫秒）——保存后对下一条消息生效，无需重启。
- **文档预处理上限**：单文件提取字符上限（默认 5 万）与单批附件总量上限（默认 15 万）；**扫描版视觉并发**：逐页转录并发数（默认 20，范围 1-20）。
- **API 接入**：Base URL、API Key（x-api-key）、Auth Token（Bearer）可直接在面板填写，保存在本机 `config.json`，**优先于 .env**，保存后立即生效（视觉提取与 AI 对话同步切换）。密钥不回显，仅显示末 4 位；留空表示保持不变。
- **视觉通道**（可选独立接入）：视觉识别（扫描版 PDF 转录、图片解析）可以使用与主对话不同的供应商和密钥——比如主对话走 GLM、视觉走 DeepSeek。填写后视觉请求完全使用该通道的 Base URL 与凭证，不再混用主接入；**全部留空则跟随主接入**，行为与旧版一致。
- 查看和删除按发送者拆分的原始报文记录。

其他操作：刷新登录二维码、轮询扫码状态并保存 token、删除历史会话。

## 微信侧常用能力

你可以直接在微信里发送普通消息、语音、图片、文件和引用消息。程序会把可解析内容整理给 AI。

**引用消息**：引用你自己发过的消息或 AI 的回复/发出的图片文件都可以——AI 能看到被引内容的文本（发出过且留有视觉描述的图片会带描述；纯图片会如实告知看不到画面）。极少数解析不到的情况，AI 会明确说"引用内容未能解析"并请你重发原文，不会静默丢失。

支持的命令包括：

```text
/new
/list
/switch <序号>
/stop          （或直接发"停止"/"终止"——强制结束当前正在处理的 AI 任务）
/tasks
/task-del <序号或ID>
确认
取消
/help
```

定时任务可以通过自然语言创建，AI 会先生成待确认草稿。你回复“确认”后才会真正创建。

## 文件自动发送

如果 AI 在当前会话工作区的：

```text
working\output_weixin\
```

生成图片或文件，程序会自动把新文件发回微信，并记录已发送状态，避免重复发送。

## 迁移到另一台电脑

最稳妥的迁移方式是复制整个文件夹，例如：

```text
D:\Apps\WeChat Claude\
```

至少要一起复制：

```text
WeChat Claude 0.1.0.exe
.wechat-claude\
.env                  可选；如果你用它保存 Claude/DeepSeek 配置
.venv\                可选；如果你需要 PDF/Office 文档解析
```

如果只复制 exe，新电脑会创建一个全新的 `.wechat-claude/`。

### 只拿 exe 迁移时要带什么

如果是全新使用，不迁移历史数据：

```text
WeChat Claude 0.1.0.exe
.env                  可选；如果你用它保存 Claude/DeepSeek 配置
```

`.wechat-claude\` 不需要手动新建。exe 首次运行会自动在同目录创建：

```text
.wechat-claude\
```

只有这些情况才需要复制旧的 `.wechat-claude\`：

- 想保留微信 `bot_token.txt`，避免重新扫码。
- 想保留历史对话。
- 想保留定时任务。
- 想保留已有工作区文件。

如果要在新电脑启用 PDF / Office 文档解析，再额外准备：

```text
scripts\preprocess-requirements.txt
.venv\                安装依赖后生成；不要手动空建
```

推荐最终目录：

```text
WeChat Claude\
├── WeChat Claude 0.1.0.exe
├── .env                         可选
├── .wechat-claude\              可选；迁移旧数据才复制
└── scripts\
    └── preprocess-requirements.txt
```

然后在目标机器运行：

```powershell
cd "D:\Apps\WeChat Claude"
uv venv .venv
uv pip install -r .\scripts\preprocess-requirements.txt --python .\.venv\Scripts\python.exe
# 没有 uv 时退回传统方式：python -m venv .venv 然后 .\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

## 迁移时启用 PDF / Office 文档解析

如果新电脑也要支持 PDF、Word、Excel、PPT 文档解析，除了 exe、`.wechat-claude/` 和 `.env`，还要准备 Python 预处理环境（仅 markitdown，体积很小）。图片解析走内置 vision，无需任何准备。可以选下面任意一种方式。

### 方式 A：新电脑在线安装

适合网络可用的新电脑。把 exe 放到固定目录后，在同一目录运行：

```powershell
cd "D:\Apps\WeChat Claude"
uv venv .venv
uv pip install -r .\scripts\preprocess-requirements.txt --python .\.venv\Scripts\python.exe
# 没有 uv 时退回传统方式：python -m venv .venv 然后 .\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

目录最后应类似：

```text
D:\Apps\WeChat Claude\
├── WeChat Claude 0.1.0.exe
├── .env
├── .wechat-claude\
├── .venv\
└── scripts\
    ├── preprocess.py
    └── preprocess-requirements.txt
```

### 方式 B：使用已有 Python 环境

适合你已经有可用的 Python venv。先在那个环境安装依赖：

```powershell
D:\Tools\wechat-python\.venv\Scripts\pip install -r "D:\Apps\WeChat Claude\scripts\preprocess-requirements.txt"
# 或用 uv：uv pip install -r "D:\Apps\WeChat Claude\scripts\preprocess-requirements.txt" --python D:\Tools\wechat-python\.venv\Scripts\python.exe
```

然后在 exe 同目录 `.env` 里加入：

```text
WECHAT_CLAUDE_PYTHON=D:\Tools\wechat-python\.venv\Scripts\python.exe
```

### 方式 C：离线拷贝 `.venv`

不推荐作为首选，但可用于离线机器。要求源机器和目标机器同为 Windows x64，Python/依赖能在目标机器正常启动。

复制：

```text
.venv\
```

到 exe 同目录。注意如果源机器的 venv 绑定了不可用的 Python 路径，目标机器可能需要重新创建 venv；现在只需要 markitdown，无需 PaddleOCR，体积远小于从前。

### 验证解析能力

准备一个 PDF，然后运行：

```powershell
cd "D:\Apps\WeChat Claude"
.\.venv\Scripts\python .\scripts\preprocess.py --mode markitdown --file .\test.pdf
```

成功会看到 JSON：

```json
{"ok": true, "text": "...", "truncated": false}
```

如果微信里发 PDF 后 AI 说“Python 预处理环境未配置”或“markitdown 未安装”，说明当前机器还没有配置好 Python 预处理环境。图片解析失败的原因会单独说明（网络/格式/大小），与 Python 无关。

## 数据目录异常在 Temp 怎么办

旧版 portable exe 曾经可能把数据写到：

```text
C:\Users\<你>\AppData\Local\Temp\<random>\.wechat-claude\
```

新版已修复，会使用 exe 所在目录。若你看到数据仍在 Temp：

1. 退出程序。
2. 确认使用的是最新重新打包的 exe。
3. 把旧 Temp 目录里的 `.wechat-claude` 复制到新 exe 所在目录旁边。
4. 重新启动 exe。

## 常见问题

### 双击没反应

先看系统托盘；程序默认不弹主窗口。

### 微信没有回复

检查管理面板里的 token 是否存在，日志里是否有错误。如果刚扫码保存 token，需要重启服务。

### AI 回复失败

检查本机 Claude Agent SDK 是否能正常运行，以及网络是否能访问相关服务。

### 管理面板打不开

确认程序正在运行。也可以托盘里点“显示状态窗口”，看当前管理面板地址。

### 数据太大

可以在管理面板删除不用的历史会话。删除会话会同时删除对应工作区。

## 卸载

1. 在托盘菜单点击“退出”。
2. 删除 exe。
3. 如果不再需要历史数据，删除 `.wechat-claude/`。
