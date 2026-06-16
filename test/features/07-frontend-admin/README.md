# Test07 - 本地前端管理面板

Test07 提供一个随 `bridge-daemon` 启动的本地管理前端，用来观察和管理当前微信桥接进程的状态。它不是新的业务入口，而是一个调试/运维面板，直接读取同一个 SQLite 运行库。

如果只想看页面怎么操作，先读 `admin-ui-usage.md`。

## 启动方式

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

启动成功后终端会打印：

```text
Admin panel: http://127.0.0.1:8787/
```

浏览器打开这个地址即可。端口可通过环境变量覆盖：

```powershell
$env:WECHAT_ADMIN_PORT="8790"
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

如果 `bot_token.txt` 不存在或为空，daemon 不再立即退出；它会保持后台面板运行。此时可以在页面刷新二维码、扫码确认并保存 token，然后重启 daemon，让微信轮询和发送链路使用新 token。

## 页面能力

### 1. 程序运行状态

页面会显示：

- 进程是否运行、PID、Node 版本
- 启动时间、当前本地时间
- 当前时区，来自 `SchedulerEngine.getTimezone()`
- 会话数、消息数、活动定时任务数、待确认草稿数
- 实际路径：数据目录、数据库路径、工作区根目录、token 文件、二维码文件

### 2. 登录二维码管理

页面支持：

- 查看当前 token 是否存在
- 查看 token 文件实际地址
- 查看二维码图片文件实际地址
- 刷新登录二维码
- 轮询二维码扫码状态
- 扫码确认后写入 `bot_token.txt`

注意：扫码确认后页面会保存 token，但当前运行中的发送/轮询对象已经用旧 token 初始化。因此页面会提示 `requiresRestart=true`，需要重启 daemon。

### 3. 历史对话

页面直接查询 `sessions` 和 `conversations` 表，列出全部历史会话，而不是微信 `/list` 命令里的最近 5 条。

每个会话会显示：

- `from_user_id`
- session ID
- 状态
- `context_token`
- 实际工作目录 `cwd`
- 最后活动时间
- 会话内消息记录

页面也支持删除会话。删除会同时清理：

- `sessions`
- `conversations`
- `turns`
- session 工作目录

### 4. 定时任务

页面支持：

- 默认列出活动任务
- 列出待确认草稿
- 创建一次性任务
- 创建每天任务
- 创建每周任务
- 创建两种模式：
  - `send_text`：到点直接发送固定微信文本
  - `agent_prompt`：到点把固定文本发给 Agent，再把 Agent 回复发回微信
- 删除任务，删除动作会把任务标记为 `cancelled`，并从默认页面列表隐藏

后台创建任务复用 Test06 的 `SchedulerEngine`。创建时先生成 draft，再按 draft ID 确认，避免误确认用户在微信里创建的其他草稿。

如果需要检查历史任务或审计删除结果，可调用：

```text
GET /api/tasks?includeInactive=1
```

## API 概览

```text
GET    /
GET    /api/status
GET    /api/auth
POST   /api/auth/qr
GET    /api/auth/qr-status
GET    /api/conversations
DELETE /api/sessions/:id
GET    /api/tasks
POST   /api/tasks
DELETE /api/tasks/:id
```

创建一次性任务：

```json
{
  "userId": "from_user_id",
  "contextToken": "context_token",
  "title": "开会提醒",
  "mode": "send_text",
  "payloadText": "你要去开会",
  "schedule": {
    "type": "once",
    "runAt": "2026-06-16T18:30:00+08:00"
  }
}
```

创建每天任务：

```json
{
  "userId": "from_user_id",
  "contextToken": "context_token",
  "title": "每日新闻",
  "mode": "agent_prompt",
  "payloadText": "帮我找今天的新闻",
  "schedule": {
    "type": "daily",
    "timeOfDay": "08:30"
  }
}
```

创建每周任务：

```json
{
  "userId": "from_user_id",
  "contextToken": "context_token",
  "title": "新闻",
  "mode": "agent_prompt",
  "payloadText": "帮我找今天的新闻",
  "schedule": {
    "type": "weekly",
    "weekday": 1,
    "timeOfDay": "09:00"
  }
}
```

## 实际测试步骤

### A. 启动与状态

1. 启动 daemon。
2. 打开终端打印的 `Admin panel` 地址。
3. 检查“程序运行状态”是否显示当前本地时间、时区和实际路径。
4. 微信发几条消息后刷新页面，确认会话数和消息数增加。

### B. 二维码

1. 删除或清空 `bot_token.txt`。
2. 启动 daemon，确认程序没有退出，并打印后台地址。
3. 打开后台，点击“刷新二维码”。
4. 扫码确认后点击“轮询扫码状态”。
5. 确认 token 文件已写入。
6. 重启 daemon，确认开始监听微信消息。

### C. 全量历史对话

1. 用 `/new` 创建多个会话，或让多个历史 session 保留在数据库里。
2. 打开后台“历史对话（全部）”。
3. 确认能看到全部 session，而不是只看到最近 5 条。
4. 检查每条 session 的实际工作目录。
5. 删除一个测试 session，确认页面刷新后消失，目录也被删除。

### D. 定时任务

1. 在页面创建一次性 `send_text` 任务，内容如“你要去开会”。
2. 在页面创建每天 `agent_prompt` 任务，内容如“帮我找今天的新闻”。
3. 刷新列表，确认任务出现。
4. 删除其中一个任务，确认它从页面列表消失。
5. 如需确认数据库状态，访问 `/api/tasks?includeInactive=1`，已删除任务状态应为 `cancelled`。
6. 对到点任务，观察微信是否收到文本或 Agent 结果。

## 自动化测试

```powershell
npm test -- test/features/07-frontend-admin/feature-07.test.ts
```

覆盖点：

- 页面包含运行状态、二维码、历史对话、定时任务四个区块
- `/api/status` 返回本地时区时间、计数和真实路径
- 二维码刷新、二维码状态轮询、token 文件保存
- 全量列出 7 个 session 和 14 条消息，不限制最近 5 条
- 删除 session 时同步删除数据库记录和工作目录
- 创建/列出/删除定时任务，删除后默认列表隐藏，审计列表保留 `cancelled`
- 每天/每周任务沿用当前时区

相关回归测试：

```powershell
npm test -- test/features/05-message-orchestration/feature-05.test.ts test/features/06-scheduler/feature-06.test.ts test/features/07-frontend-admin/feature-07.test.ts
npx tsc --noEmit
```
