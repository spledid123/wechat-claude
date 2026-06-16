# WeChat Claude exe 使用说明

这份文档面向只使用 exe 的用户，不需要了解源码。

## 你需要什么

- Windows 10/11 x64。
- 一个可用的微信机器人登录二维码。
- 可访问微信 iLink Bot API 的网络。
- 可用的 Claude Agent SDK 运行环境。当前 exe 已包含项目依赖和 Claude SDK 包，但 Claude 账号/认证仍依赖本机环境中 Claude SDK 的可用状态。

如果程序能启动但 AI 回复失败，优先检查本机 Claude/Anthropic 登录或网络环境。

## exe 不需要安装什么

只运行打包好的 exe 时，不需要安装或复制：

- Node.js。
- npm。
- 项目里的 `node_modules/`。
- Claude Code SDK / Claude Agent SDK npm 包。
- 项目里的 Python `.venv/`。
- 开发目录里的 `.claude/`。
- `src/`、`test/`、`scripts/` 等源码目录。

exe 已经内置 Electron/Node 运行时、项目编译后的 JavaScript、`@anthropic-ai/claude-agent-sdk`、Windows x64 的 `claude.exe`、`sql.js` 和 `qrcode`。

Python 不是基础运行依赖。普通聊天、微信收发、定时任务、自动发送已有文件不需要 Python。只有当你需要图片 OCR、Office/PDF/表格等文件预处理能力，并且当前预处理实现依赖本机 Python 工具时，才需要额外安装 Python 和对应工具链。

## PDF / 图片解析依赖

如果你要让程序读取图片、PDF、Word、Excel、PPT 内容，需要准备 Python 预处理环境。支持范围与 `test/features/03-file-preprocessing/README.md` 一致：

| 文件类型 | 工具 | 说明 |
| --- | --- | --- |
| `.png .jpg .jpeg .gif .bmp .webp` | PaddleOCR | 中文/英文 OCR |
| `.pdf .docx .doc .xlsx .xls .pptx .ppt` | markitdown | 转 Markdown 文本 |
| `.txt .py .js .csv .json .md .log` 等 | 内置读取 | 不需要 Python |

推荐在 exe 同目录创建 `.venv`：

```powershell
cd "D:\Apps\WeChat Claude"
python -m venv .venv
.\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

如果你不想把 `.venv` 放在 exe 同目录，也可以在 `.env` 中指定 Python：

```text
WECHAT_CLAUDE_PYTHON=D:\Tools\wechat-python\.venv\Scripts\python.exe
```

新版 exe 会把 `scripts\preprocess.py` 和 `scripts\preprocess-requirements.txt` 作为运行资源带上。首次运行 PaddleOCR 可能需要下载模型，图片 OCR 会比较慢；大图可能需要 10-30 秒。

手动验证命令：

```powershell
.\.venv\Scripts\python .\scripts\preprocess.py --mode ocr --file .\some-image.png
.\.venv\Scripts\python .\scripts\preprocess.py --mode markitdown --file .\some-file.pdf
```

成功时会输出 JSON，例如：

```json
{"ok": true, "text": "提取到的文字...", "truncated": false}
```

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

页面可以查看：

- 程序是否运行。
- 当前本地时区时间。
- token 和二维码状态。
- 数据目录、数据库、工作区真实路径。
- 全部历史对话。
- 定时任务列表。

页面也可以执行：

- 刷新登录二维码。
- 轮询扫码状态并保存 token。
- 删除历史会话。
- 创建、删除一次性/每天/每周定时任务。

## 微信侧常用能力

你可以直接在微信里发送普通消息、语音、图片、文件和引用消息。程序会把可解析内容整理给 AI。

支持的命令包括：

```text
/new
/list
/switch <序号>
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
.venv\                可选；如果你需要 PDF/图片/Office 解析
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

如果要在新电脑启用 PDF / 图片 / Office 解析，再额外准备：

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
python -m venv .venv
.\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
```

## 迁移时启用 PDF / 图片解析

如果新电脑也要支持图片 OCR、PDF、Word、Excel、PPT 解析，除了 exe、`.wechat-claude/` 和 `.env`，还要准备 Python 预处理环境。可以选下面任意一种方式。

### 方式 A：新电脑在线安装

适合网络可用的新电脑。把 exe 放到固定目录后，在同一目录运行：

```powershell
cd "D:\Apps\WeChat Claude"
python -m venv .venv
.\.venv\Scripts\pip install -r .\scripts\preprocess-requirements.txt
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

到 exe 同目录。注意 `.venv` 通常很大，PaddleOCR 相关环境可能超过 1GB；如果源机器的 venv 绑定了不可用的 Python 路径，目标机器可能需要重新创建 venv。

### 验证解析能力

准备一张图片和一个 PDF，然后运行：

```powershell
cd "D:\Apps\WeChat Claude"
.\.venv\Scripts\python .\scripts\preprocess.py --mode ocr --file .\test.png
.\.venv\Scripts\python .\scripts\preprocess.py --mode markitdown --file .\test.pdf
```

成功会看到 JSON：

```json
{"ok": true, "text": "...", "truncated": false}
```

如果微信里发图片/PDF 后 AI 说“Python 预处理环境未配置”或“markitdown/paddleocr 未安装”，说明当前机器还没有配置好 Python 预处理环境。

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
