# Test 06: 定时任务器

状态：已实现，并通过自动化测试与微信实测。

Test 06 新增一个微信定时任务器，支持：

- 按当前时区执行任务。
- 某天几点发送固定微信文本。
- 每天某个固定时间循环发送固定微信文本。
- 每周某一天几点循环发送固定微信文本。
- 到点后把预设 prompt 发给 Agent，再把 Agent 结果发回微信。
- AI 返回严格 JSON 创建定时任务草稿，用户确认后才真正创建。
- 用户命令列出、删除、确认、取消定时任务。
- 自动清理过期草稿和过期一次性任务。

## 一、时区规则

定时任务器默认使用当前运行环境时区：

```ts
Intl.DateTimeFormat().resolvedOptions().timeZone
```

测试中固定为 `Asia/Shanghai`。所有任务记录都会保存 `timezone` 字段，确认文本和列表也会显示该时区。

## 二、任务类型

### 2.1 直接发送微信文本

适合提醒类任务，例如：

```text
你要去开会
```

到点后桥接层直接调用微信发送接口。

### 2.2 触发 Agent

适合需要实时处理的任务，例如：

```text
帮我找今天的新闻
```

到点后调 Agent，拿到结果后再发回微信。

## 三、时间类型

### 3.1 一次性任务

某天某个具体时间执行一次。

示例：

```text
2026-06-16 18:30
```

执行成功后状态变为 `completed`。

一次性任务有 24 小时补执行窗口。调度器仍然每 30 秒检查一次任务；如果某次 tick 比 `run_at` 晚几十秒或几分钟，任务仍会执行。只有超过 `run_at + 24小时` 还没有执行，才会标记为 `expired`。

### 3.2 每天任务

每天固定时间执行。

示例：

```text
09:00
```

执行成功后自动计算下一天同一时间的 `next_run_at`。如果创建时今天的该时间还没到，首次执行就是今天；如果已经过了，首次执行就是明天。

### 3.3 每周任务

每周固定星期几和固定时间执行。

内部 weekday 规则：

```text
0=周日, 1=周一, 2=周二, 3=周三, 4=周四, 5=周五, 6=周六
```

执行成功后自动计算下一周的 `next_run_at`。

## 四、AI JSON 创建流程

不用 MCP。AI 需要返回严格 JSON，由软件解析后创建草稿：

```json
{
  "wechat_schedule_task": {
    "title": "新闻",
    "mode": "agent_prompt",
    "payloadText": "帮我找今天的新闻",
    "schedule": {
      "type": "once",
      "runAt": "2026-06-16T18:30:00+08:00"
    }
  }
}
```

每天任务：

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

每周任务：

```json
{
  "wechat_schedule_task": {
    "title": "周会",
    "mode": "send_text",
    "payloadText": "你要去开会",
    "schedule": {
      "type": "weekly",
      "weekday": 1,
      "timeOfDay": "09:00"
    }
  }
}
```

软件只创建草稿，不直接创建正式任务。返回给用户的确认格式类似：

```text
请确认创建定时任务：
标题：新闻
类型：触发 AI 后发送结果
时间：每周一 08:30 (Asia/Shanghai)
内容：帮我找今天的新闻

回复“确认”创建，回复“取消”放弃。
```

用户回复“确认”后，草稿转为正式任务；回复“取消”后，草稿删除。

## 五、用户命令

| 命令 | 作用 |
|---|---|
| `/tasks` | 列出当前用户的定时任务 |
| `定时任务` | 同 `/tasks` |
| `/task-del <序号或ID>` | 删除定时任务 |
| `删除定时任务 <序号或ID>` | 同 `/task-del` |
| `确认` | 确认最近一条定时任务草稿 |
| `取消` | 取消最近一条定时任务草稿 |
| `/task-draft 2026-06-16 18:30 \| 你要去开会` | 测试用：创建一次性直接发送草稿 |
| `/task-draft daily 09:00 \| 每天提醒` | 测试用：创建每天直接发送草稿 |
| `/task-draft weekly 1 09:00 \| 每周提醒` | 测试用：创建每周直接发送草稿 |

正式自然语言创建依赖 AI 返回 `wechat_schedule_task` JSON；命令里的 `/task-draft` 是为了人工测试和自动化测试保留的明确格式入口。

## 六、Live 接入

已接入：

- `scripts/bridge-daemon.ts`
- `scripts/bridge-test.ts`
- `test/features/05-message-orchestration/orchestrator.ts`

桥接进程启动后会创建 `SchedulerEngine`，并每 30 秒执行一次：

```ts
scheduler.runDueTasks()
```

调度器命令会在消息进入防抖队列之前处理，所以 `/tasks`、`确认`、`取消`、`/task-del` 不会等待防抖窗口。

## 七、自动化测试

运行：

```powershell
cmd.exe /d /s /c npm.cmd test -- test/features/06-scheduler/feature-06.test.ts
```

覆盖用例：

- 使用当前时区。
- 一次性文本任务到点发送并完成。
- 每天文本任务到点发送并重排到下一天。
- 每周文本任务到点发送并重排到下一周。
- Agent 任务到点触发 Agent 并发送结果。
- AI 严格 JSON 创建格式化草稿。
- 命令确认、取消、列出、删除。
- 过期草稿和过期一次性任务清理。
- 编排器立即处理定时任务命令，不进入防抖。

## 八、微信实测

启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

实测命令：

```text
/help
/list
/tasks
/task-draft 2026-06-16 15:05 | 你要去开会
/task-draft daily 09:00 | 每天提醒
确认
```

自然语言创建：

```text
帮我创建一个今天15:08的定时任务，到时候帮我找今天的新闻并发给我，先让我确认。
```

实测结论：

- `/help` 能看到定时任务相关命令。
- `/list` 不再重复回复两条。
- `/tasks` 能列出当前用户 active 定时任务。
- `/task-draft ...` 能创建草稿，用户回复“确认”后写入 SQLite。
- 一次性任务到点后能触发，不会因为 30 秒 tick 迟到而立即过期。
- 自然语言创建不再依赖 MCP，也不再走 Claude SDK 内置 `CronCreate`。
- AI 创建流程改为返回 `wechat_schedule_task` JSON，软件解析后生成确认文本。

## 九、已修问题

### 9.1 `/list` 双回复

原因：

- `/list` 原本没有被编排器识别为立即命令，会进入防抖。
- 防抖 flush 后，`Bridge.handleMessages()` 内部命令分支发了一次。
- `MessageOrchestrator.sendReplyBubbles()` 又把返回值发了一次。

修复：

- `/list`、`/switch` 等命令加入立即命令路径。
- `Bridge.handleMessages()` 的命令分支尊重 `deliverReply`。
- 由 Orchestrator 统一负责最终发送，避免双发。

### 9.2 一次性任务过期太快

原因：

- 旧逻辑把一次性任务 `expires_at` 设置为 `run_at`。
- scheduler 每 30 秒 tick 一次，如果 tick 比任务时间晚几秒，任务会先被标记 `expired`，还没执行。

修复：

- 一次性任务的 `expires_at` 改为 `run_at + 24小时`。
- `runDueTasks()` 先执行到期任务，再清理真正过期的任务。

### 9.3 AI 误用内置 Cron

原因：

- Claude SDK 默认暴露 `CronCreate`、`CronDelete`、`CronList`、`ScheduleWakeup`。
- AI 自然语言创建时可能优先使用这些内置工具。
- 这些工具创建的是 session-only 临时任务，不写入本项目 SQLite，也不走用户确认。

修复：

- 权限层拒绝内置 Cron/ScheduleWakeup 工具。
- prompt 明确禁止使用 Cron/MCP/Bash/文件来创建定时任务。
- 软件只接受 `wechat_schedule_task` JSON，并由本地 scheduler 创建草稿。

## 十、相关文件

- [scheduler.ts](/d:/1/wechat_claude/test/features/06-scheduler/scheduler.ts)
- [feature-06.test.ts](/d:/1/wechat_claude/test/features/06-scheduler/feature-06.test.ts)
- [orchestrator.ts](/d:/1/wechat_claude/test/features/05-message-orchestration/orchestrator.ts)
- [bridge-daemon.ts](/d:/1/wechat_claude/scripts/bridge-daemon.ts)
- [bridge-test.ts](/d:/1/wechat_claude/scripts/bridge-test.ts)
