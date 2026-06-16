# 正式运行时说明

正式运行时由 CLI 和 Electron 托盘共同复用。核心服务在 `src/runtime`，业务模块在 `src/features`。

## 启动

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-service.ps1
```

或：

```powershell
npm run app:service
```

启动后会显示：

```text
Admin panel : http://127.0.0.1:8787/
Data dir    : D:\1\wechat_claude\.wechat-claude
Log file    : D:\1\wechat_claude\.wechat-claude\logs\service.log
```

## 数据目录

正式版默认把所有运行数据放在项目内：

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
    └── session-xxxxxxxx/
```

这和旧测试脚本不同：旧脚本默认使用 `.tmp/wechat-integration-test/`。

如果想临时改数据目录，可设置：

```powershell
$env:WECHAT_CLAUDE_DATA_DIR="D:\1\wechat_claude\.wechat-claude-dev"
npm run app:service
```

## 无 token 启动

如果 `.wechat-claude/bot_token.txt` 不存在或为空，服务不会退出。它会进入 `waiting_for_login` 状态，并保持后台管理页可用。

操作流程：

1. 打开 `http://127.0.0.1:8787/`。
2. 点击“刷新二维码”。
3. 微信扫码确认。
4. 点击“轮询扫码状态”。
5. token 写入 `.wechat-claude/bot_token.txt`。
6. 重启服务。

## 停止

按一次：

```text
Ctrl+C
```

如果仍卡住，再按第二次会强制退出。

## 与托盘程序的关系

正式运行时入口是：

```text
src/runtime/service.ts
```

它提供：

- `start()`
- `stop()`
- `waitUntilStopped()`
- `getStatus()`

Electron 托盘程序直接 import 这个 service，不复制 bridge、scheduler、admin、poller 逻辑。

## 当前已接入功能

- 微信长轮询接收消息
- Claude 会话与工作区
- 文件预处理
- 引用消息解析
- 消息防抖合并
- 多气泡拆分
- 正在输入状态
- 自动发送 `working/output_weixin`
- 工作区写权限限制
- 定时任务
- 本地 admin 前端
- QR 登录管理
- 日志与引用调试记录

## 验证命令

```powershell
npm test -- test/features/02-wechat-connectivity/feature-02.test.ts test/features/04-bridge/feature-04.test.ts test/features/05-message-orchestration/feature-05.test.ts test/features/06-scheduler/feature-06.test.ts test/features/07-frontend-admin/feature-07.test.ts test/runtime/service.test.ts
npx tsc --noEmit
```
