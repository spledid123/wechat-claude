# 打包说明

当前打包形态为 **Tauri 壳 + 内置 Node + 首跑按需下载** 的便携目录版。`release/` 与 `build/` 是构建产物目录，不提交 git，需要时重新生成。

普通用户使用 exe 请看 [user-exe-guide.md](user-exe-guide.md)。维护者了解架构和依赖请看 [architecture.md](architecture.md)。

## 产物

```text
release/
└── WeChatClaude-portable-<版本>.zip    ← 便携版（约 47MB，给使用者）
```

zip 解压到任意目录后运行里面的 `WeChat Claude.exe`。目录布局（扁平，数据与 .env 都落在 exe 旁）：

```text
WeChatClaude/
├── WeChat Claude.exe     Tauri 托盘壳（约 3MB）
├── node/node.exe         Node 22 LTS 运行时（约 83MB）
├── dist/                 编译后的服务代码
├── node_modules/         生产 JS 依赖（--omit=dev --omit=optional）
├── scripts/              preprocess.py + requirements（Python 环境安装用）
├── skills/               文档生成参考技能（约 1MB）
└── package.json
```

**大体积组件不随包分发**，首次运行时由安装向导下载：

| 组件 | 大小 | 落地位置 | 下载源 |
| --- | --- | --- | --- |
| Claude CLI（claude.exe） | ~218MB | `.wechat-claude\runtime\claude\claude.exe` | npmmirror（备源 registry.npmjs.org），版本与包内 SDK 锁定 |
| uv + Python 环境（可选） | ~360MB | `.wechat-claude\runtime\uv\` + `.wechat-claude\.venv\` | GitHub Releases（uv），托管 CPython 与 PyPI 包由 uv 解析 |

## 首跑安装向导

壳拉起 Node 服务后轮询 `/api/status`；服务检测到既无数据目录内的 claude.exe、也无 node_modules 内置平台包时进入 `bootstrap` 状态，壳弹出安装器窗口（加载 `http://127.0.0.1:8787/`，由服务渲染安装页）：

- **① Claude Agent 运行时（必需）**：点击下载 tgz → 流式落盘（进度条按 Content-Length）→ tar 解出 claude.exe → 写 `version.json` → 服务在进程内继续完成启动，**安装窗口保持打开**（不会自动弹浏览器；页面内"打开管理面板"、托盘菜单或左键托盘图标进入面板；托盘"组件安装"随时重开并自动回到安装页，`/install` 为常驻路由，面板头部也有"组件安装"入口）。
- **② Python 文档解析环境（可选）**：下载 uv zip → `uv venv` → `uv pip install -r scripts/preprocess-requirements.txt --python <venv>\Scripts\python.exe`，全程免管理员。

bootstrap 期间除安装页与 `/api/bootstrap*`、`/api/status`、`/api/shutdown` 外其余 API 一律 503。下载失败可重试；向导窗口关闭仅隐藏（下载继续）。调试旋钮：`WECHAT_CLAUDE_BOOTSTRAP_FORCE=1` 强制进入安装页（补装 Python / 调试用）。

## 构建命令

```powershell
# 一次性：安装壳构建工具链（VS Build Tools + Rust，幂等）
npm run setup:tauri

# 出便携包 zip（内部依次：build:app → npm ci 生产依赖 → 下载缓存 Node 22 → cargo release → 组装 → Compress-Archive）
npm run dist:portable

# 源码转移 zip（git 跟踪文件）
npm run dist:src:zip
```

`scripts/build-portable.mjs` 细节：

- 生产依赖在 `build/npm-stage` 里 `npm ci --omit=dev --omit=optional`，因此 **218MB 的 `@anthropic-ai/claude-agent-sdk-win32-x64` 不会进包**。
- Node 运行时锁定 `22.23.2`（win-x64），首次构建下载后缓存到 `.tmp/node-runtime/`，此后离线可重复出包。
- 壳产物为 `src-tauri/target/release/wechat-claude-shell.exe`（bundle 关闭，二进制名取 crate 名），组装时改名为 `WeChat Claude.exe`。
- cargo 构建需要注意代理：若系统代理不可用，`NO_PROXY=*` 环境变量可让 cargo 直连。

## 运行机依赖边界

最终用户只解压运行 zip 时，不需要安装：

- Node.js / npm / Rust / 任何开发工具。
- Claude Code CLI（首跑向导下载）。
- Python（仅当需要 PDF/Office 解析时，由可选按钮安装）。

需要外部提供：

- Claude/DeepSeek/Anthropic 认证配置：系统环境变量、exe 同目录 `.env` 或 `.wechat-claude\.env`。
- 网络：微信 iLink Bot API、模型 API；首次运行另需 npm 镜像（下载 Claude 运行时）。
- WebView2 运行时（Win10 2004+/Win11 系统自带；缺失时壳会引导联网补装）。

## 数据目录

数据目录默认是 exe 所在目录旁的 `.wechat-claude\`（可 `WECHAT_CLAUDE_DATA_DIR` 覆盖），包含 token、数据库、工作区、日志，以及首跑下载的 `runtime\claude\` 与可选 `.venv\`。迁移到新机器：整个复制 exe 目录 + `.wechat-claude\` + 可选 `.env`。

## Claude SDK 配置

exe 不内置任何密钥。运行时按顺序读取：系统环境变量 → exe 同目录 `.env` → `.wechat-claude\.env`；管理面板"设置"页保存的 `config.json` 优先级最高。`.env` 示例：

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

服务把数据目录内的 `runtime\claude\claude.exe` 经 SDK 的 `pathToClaudeCodeExecutable` 传入（`WECHAT_CLAUDE_CLAUDE_EXE` 可覆盖）；启动日志会打印实际使用的路径。

## 已知限制

- 没有代码签名：SmartScreen 会提示未知发布者（与旧版一致）。
- npmmirror 的平台包 tgz 与 npmjs 同步偶有延迟；备源自动切换，仍失败时安装页可重试。
- 单实例：第二个 exe 启动只会唤起已有实例（弹安装器窗口或打开面板），不会重复起服务。
- npm audit 对依赖树的提示未处理。
