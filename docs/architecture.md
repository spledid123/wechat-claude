# 项目架构、功能、依赖与打包

本文档面向维护者，说明 WeChat Claude 的正式实现结构、核心功能、运行数据、依赖和打包流程。

## 一、总体架构

```text
WeChat iLink Bot API
        |
        v
src/features/02-wechat-connectivity/wechat/
        |
        v
src/features/05-message-orchestration/
        |
        v
src/features/04-bridge/
        |
        v
src/features/01-claude-dialogue/
        |
        v
Claude Agent SDK
```

正式服务入口：

```text
src/runtime/service.ts
```

Electron 托盘入口：

```text
src/electron/main.ts
```

CLI 入口：

```text
src/cli.ts
```

## 二、主要目录

```text
src/features/01-claude-dialogue/       Claude 会话、权限、数据库、会话记录
src/features/02-wechat-connectivity/   微信 API、轮询、发送、上传、加密
src/features/03-file-preprocessing/    图片 OCR、文档/表格/文本抽取
src/features/04-bridge/                微信消息到 Claude 的桥接逻辑、自动发送文件
src/features/05-message-orchestration/ 消息防抖合并、正在输入状态、多气泡回复
src/features/06-scheduler/             一次性/每天/每周定时任务
src/features/07-frontend-admin/        本地管理后台
src/runtime/                           正式服务生命周期、日志、路径、微信发送包装
src/electron/                          托盘菜单、状态窗口、portable 路径修复
scripts/                               构建、启动、打包辅助脚本
docs/                                  文档
test/                                  回归测试与历史分阶段文档
```

`test/` 被保留，但正式运行时不依赖 `test/features`。生产构建只编译 `src/**/*.ts`。

## 三、核心功能

### 3.1 微信连接

模块：

```text
src/features/02-wechat-connectivity/wechat/
```

接口参数、消息结构、CDN 加密和踩坑记录见 [微信 iLink Bot API 实战文档](wechat-ilink-api.md)。

能力：

- 获取登录二维码。
- 轮询二维码扫码状态。
- 保存 `bot_token.txt`。
- 长轮询接收微信消息。
- 发送文字、图片、文件。
- 处理上传签名和加密字段。

### 3.2 Claude 对话

模块：

```text
src/features/01-claude-dialogue/
```

能力：

- 每个微信会话对应一个 Claude 工作区。
- 会话记录写入 SQLite。
- 历史上下文注入 prompt。
- 支持 `/new`、`/list`、`/switch`。
- 限制 Claude 写入范围：只能写当前 session 工作区，外部目录只读。
- 禁止 Claude 使用交互确认类工具，尽量保证任务自动完成。

### 3.3 文件与引用

模块：

```text
src/features/03-file-preprocessing/
src/features/04-bridge/
```

能力：

- 语音优先使用微信转写文本。
- 图片、文件先预处理成文本，再给 AI。
- 引用图片/文件/语音时，使用历史索引中的文本内容。
- 若引用媒体无法解析，不降级给 AI，而是直接向微信返回失败说明。

PDF/图片/Office 预处理依赖正式资源 `scripts/preprocess.py`。图片使用 PaddleOCR，PDF/Office 使用 markitdown；目标机器需要单独准备 Python `.venv` 或通过 `WECHAT_CLAUDE_PYTHON` 指定 Python。普通聊天和微信收发不需要 Python。

### 3.4 消息编排

模块：

```text
src/features/05-message-orchestration/
```

能力：

- 短时间内多条微信消息防抖合并。
- 媒体消息使用更长防抖窗口。
- `/tasks`、`确认`、`取消` 等命令不进防抖，立即处理。
- 支持 `<<<MSG>>>` 多气泡拆分。
- 支持“正在输入”状态指示；如果微信接口没有 typing ticket，则自动禁用。

### 3.5 定时任务

模块：

```text
src/features/06-scheduler/
```

能力：

- 一次性任务：某天几点执行一次。
- 每天任务：每天固定时间执行。
- 每周任务：每周固定星期几和时间执行。
- 直接发微信文本。
- 触发 Agent，再把 Agent 回复发回微信。
- AI 创建任务必须返回严格 JSON，软件生成草稿，用户确认后才创建。
- 支持 `/tasks` 列出和 `/task-del` 删除。

AI JSON 示例：

```json
{
  "wechat_schedule_task": {
    "title": "每日新闻",
    "mode": "agent_prompt",
    "payloadText": "帮我找今天的新闻",
    "schedule": {
      "type": "daily",
      "timeOfDay": "08:30"
    }
  }
}
```

### 3.6 本地管理后台

模块：

```text
src/features/07-frontend-admin/admin.ts
```

能力：

- 查看运行状态、PID、时区、本地时间。
- 查看 token、二维码、数据目录、数据库路径、工作区路径。
- 列出全部历史对话。
- 删除会话并清理工作区。
- 列出、创建、删除定时任务。
- 刷新二维码并保存 token。

### 3.7 Electron 托盘

模块：

```text
src/electron/
```

能力：

- 后台启动正式 service。
- 系统托盘菜单。
- 打开管理面板。
- 打开数据目录和日志文件。
- 重启服务。
- 退出程序。
- portable exe 数据目录修复：优先使用 `PORTABLE_EXECUTABLE_DIR`。

## 四、数据目录

正式默认数据目录：

```text
<程序所在目录>\.wechat-claude\
```

目录内容：

```text
.wechat-claude/
├── bot_token.txt
├── wechat-qr.png
├── bridge-data/
│   └── relay.sqlite
├── logs/
│   ├── service.log
│   └── quote-listener.jsonl
└── workspaces/
    └── session-xxxx/
        ├── incoming/
        ├── working/
        │   └── output_weixin/
        └── output/
```

说明：

- `bot_token.txt` 是微信登录 token。
- `relay.sqlite` 保存会话、消息、定时任务、草稿等数据。
- `workspaces/` 是 Claude 每个会话的工作区。
- `working/output_weixin/` 中的新文件会自动发回微信。

## 五、数据库

数据库使用 `sql.js`，运行时是 SQLite 文件：

```text
.wechat-claude/bridge-data/relay.sqlite
```

迁移文件：

```text
src/features/01-claude-dialogue/db/migrations/
```

当前迁移：

- `001_initial.sql`：用户、会话、消息、引用索引、turns。
- `002_message_text_index.sql`：文件名和媒体 key 索引。
- `003_scheduled_tasks.sql`：定时任务和草稿。
- `004_daily_scheduled_tasks.sql`：新增每天任务类型。

## 六、依赖

运行依赖：

- `@anthropic-ai/claude-agent-sdk`：Claude Agent SDK。
- `sql.js`：SQLite WASM。
- `qrcode`：二维码图片生成。

开发/打包依赖：

- `typescript`：TypeScript 编译。
- `tsx`：开发时运行 TypeScript。
- `vitest`：测试。
- `electron`：桌面托盘程序。
- `electron-builder`：Windows 打包。
- `@types/node`、`@types/sql.js`：类型声明。

用户运行 exe 时不需要安装 Node.js 或 npm；但 Claude Agent SDK 的认证/可用性仍依赖本机环境和网络。正式运行时会读取系统环境变量、程序目录 `.env` 和数据目录 `.wechat-claude/.env`，不把密钥打进 exe，也不要求迁移开发目录里的 `.claude/`。

## 七、构建与打包

编译正式 app：

```powershell
npm run build:app
```

开发模式启动 Electron：

```powershell
npm run electron:dev
```

生成单文件 portable exe：

```powershell
npm run dist:win
```

生成目录版：

```powershell
npm run dist:win:dir
```

生成 zip：

```powershell
npm run dist:win:zip
```

打包配置在 `package.json` 的 `build` 字段中。构建输出目录是：

```text
release/
```

该目录是生成物，不提交到 git。

## 八、测试策略

完整测试：

```powershell
npm test
```

类型检查：

```powershell
npx tsc --noEmit
```

正式 runtime 重点测试：

```powershell
npm test -- test/runtime/service.test.ts test/runtime/electron-main.test.ts
```

说明：

- `test/` 保留历史分阶段测试和回归测试。
- 正式代码已经迁移到 `src/features/`。
- 如果修改了正式实现，建议同步更新对应测试，避免 `src/features` 和 `test/features` 行为漂移。

## 九、发布前检查

建议顺序：

1. `npm install`
2. `npm test`
3. `npx tsc --noEmit`
4. `npm run build:app`
5. `npm run dist:win`
6. 启动 exe，确认数据目录在 exe 旁边的 `.wechat-claude/`
7. 打开管理面板，扫码登录
8. 微信实测普通消息、文件、引用、定时任务、自动发送文件

## 十、已知限制

- 当前没有自定义应用图标，使用 Electron 默认图标。
- 当前没有代码签名，Windows 可能提示未知发布者。
- npm audit 可能提示 Electron/builder 生态依赖风险，正式公开发布前应单独处理。
- 测试目录和正式目录目前存在一份历史重复实现，后续可逐步把测试改为直接覆盖 `src/features`，再删除 `test/features` 中的重复源码。
