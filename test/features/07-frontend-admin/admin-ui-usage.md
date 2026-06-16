# Test07 前端操作说明

这份文档只说明本地管理前端怎么用。功能实现和自动化测试见同目录 `README.md`。

## 启动

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

终端出现下面内容后，浏览器打开后台地址：

```text
Admin panel: http://127.0.0.1:8787/
Listening for WeChat messages...
```

如果只看到 `Admin panel`，但没有 `Listening for WeChat messages...`，通常表示 token 不存在或为空。此时后台页面仍可打开，用来刷新二维码并保存 token。

## 顶部按钮

### 刷新全部

作用：重新从本地后台读取一次最新状态。

它会刷新：

- 程序运行状态
- token 和二维码状态
- 历史对话列表
- 定时任务列表

它不会：

- 重新登录微信
- 创建或删除任何数据
- 触发定时任务
- 重启 bridge

适合在微信发完消息、删除会话、删除任务后手动更新页面。

### 刷新二维码

作用：向微信登录接口申请一个新的登录二维码，并保存为本地图片。

使用场景：

- `bot_token.txt` 不存在
- token 过期
- 想重新扫码登录
- 页面显示没有二维码

点击后页面会显示二维码图片。此时还没有完成登录，只是生成了二维码。

### 轮询扫码状态

作用：检查刚才生成的二维码是否已经被微信扫码并确认。

标准流程：

1. 点击“刷新二维码”。
2. 用微信扫码并确认。
3. 点击“轮询扫码状态”。
4. 如果微信返回 confirmed，后台会写入 `bot_token.txt`。
5. 重启 bridge-daemon，让程序使用新 token。

注意：保存 token 后，当前运行中的微信轮询和发送对象不会热替换 token，所以需要重启。

## 程序运行状态

这个区域用来确认当前 daemon 是否活着，以及它正在使用哪些真实路径。

重点看：

- `本地时间`：确认时区和系统时间是否正常。
- `数据目录`：默认是 `.tmp/wechat-integration-test`。
- `数据库`：默认是 `.tmp/wechat-integration-test/bridge-data/relay.sqlite`。
- `工作区根目录`：每个会话的 workspace 都在这里。
- `会话 / 消息 / 任务`：当前数据库里的数量统计。

## 登录二维码区域

这个区域显示：

- token 是否存在
- token 文件实际地址
- 二维码文件实际地址
- 当前二维码图片
- 当前 qrcode 标识

如果 token 已保存但微信仍无响应，优先重启 bridge-daemon。

## 历史对话

这里显示全部历史会话，不是微信 `/list` 命令里的最近 5 条。

每个会话显示：

- 微信用户 ID
- session ID
- `context_token`
- 实际工作目录
- 最后活动时间
- 会话内消息记录

### 删除会话

点击会话右侧“删除”后，会删除：

- `sessions` 表中的会话记录
- `conversations` 表中的消息记录
- `turns` 表中的缓冲记录
- 对应 session 工作目录

删除是物理删除，删完后后台列表里看不到这条会话。

## 定时任务

默认页面只显示 `active` 定时任务。

### 创建任务

必填项：

- 用户 ID：通常填当前微信用户的 `from_user_id`。
- `context_token`：通常填当前会话里的微信 `context_token`。
- 标题：给任务看的名字。
- 模式：
  - `直接发微信文本`：到点直接把内容发给用户。
  - `触发 AI 后发送结果`：到点把内容当 prompt 发给 Agent，再把 Agent 回复发给用户。
- 计划类型：
  - `一次性`：选择具体日期时间。
  - `每天`：选择每天执行的固定时间。
  - `每周`：选择星期和时间。
- `每天/每周时间`：每天和每周任务共用这个时间字段。
- 文本 / Agent 提示词：实际发送文本或 Agent prompt。

### 删除任务

点击“删除”后，任务会从页面默认列表消失。

底层实现是软删除：数据库中保留任务记录，状态改为 `cancelled`。这是为了后续排查和审计。

如果需要查看已删除或已完成任务，可访问：

```text
http://127.0.0.1:8787/api/tasks?includeInactive=1
```

## 重启和停止

停止：

```text
Ctrl+C
```

正常情况下按一次即可退出。若仍卡住，再按第二次会强制退出。

重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

以下情况需要重启：

- 扫码保存了新的 token
- 修改了代码
- 前端行为还是旧版本
- 微信连接长时间无响应

## 常见判断

### 点了删除任务，为什么 API 里还能看到？

页面默认隐藏已删除任务，但审计 API 仍可看到。

- 页面默认：`/api/tasks`，只显示 `active`
- 审计历史：`/api/tasks?includeInactive=1`，显示 `cancelled/completed/expired`

### 点了轮询扫码状态，没有成功？

通常是以下原因：

- 还没点“刷新二维码”
- 二维码还没扫码确认
- 二维码过期
- 微信接口没有返回 `confirmed`

重新点“刷新二维码”，扫码后再点“轮询扫码状态”。

### 页面刷新后还是旧行为？

大概率是 daemon 没重启，浏览器连的还是旧进程代码。

先 `Ctrl+C` 停止，再重新运行启动命令。
