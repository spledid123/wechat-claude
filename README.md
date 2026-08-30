# WeChat Claude

WeChat Claude 是一个本地运行的微信 Claude 桥接程序。它把微信消息交给 Claude Agent 处理，再把回复、生成文件或定时任务结果发回微信；正式版本通过 Electron 托盘运行，并提供本地管理面板。

这份 README 面向接手项目的人类工程师。普通使用者请看 [用户版 exe 使用说明](docs/user-exe-guide.md)，架构细节请看 [项目架构与打包说明](docs/architecture.md)，微信接口细节请看 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。

## 当前状态

- 正式源码在 `src/`，核心业务模块在 `src/features/`。
- 本地数据默认写入程序所在目录旁边的 `.wechat-claude/`，不会提交到 git。
- Windows portable exe 通过 `electron-builder` 生成，产物在 `release/`，不会提交到 git。

## 快速开始

```powershell
npm run setup
npm run build:app
npm start
```

`npm run setup` 一键安装全部依赖：Node 包（`npm install`，含打包工具链）+ Python 预处理环境（uv 管理，仅 markitdown，约 290MB；机器上没有 uv 时自动跳过并给出提示——不影响图片理解与普通聊天，仅 PDF/Office 解析不可用）。也可以只跑 `npm install` 不装 Python。

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
docs/                使用、架构、打包说明
```

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
- 管理后台在 `src/features/07-frontend-admin/admin.ts`，含"模型与图片设置"和报文记录管理。
- 图片解析走 DeepSeek vision（`src/features/03-file-preprocessing/vision.ts`），直连/分离模式与模型名在 `.wechat-claude/config.json`，管理面板可改、即时生效；OCR 已移除。
- PDF/Office 文档解析走可选的 Python markitdown（`scripts/preprocess.py`），图片能力不依赖 Python。
- 微信收发 API 在 `src/features/02-wechat-connectivity/wechat/`，参数和踩坑见 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。
- Claude 权限和工作区限制在 `src/features/01-claude-dialogue/claude/permissions.ts`。
- Electron portable 数据目录修复逻辑在 `src/electron/paths.ts`。
- 日志按大小轮转（`WECHAT_CLAUDE_LOG_MAX_MB`），原始报文按发送者记录在 `logs/quote/`；存储保留期由 `WECHAT_CLAUDE_RETENTION_DAYS` 控制。
