# Test 05: 权限沙箱与自动文件发送

状态：2026-06-16 已完成代码测试与微信实测。

本文档记录 Test 05 阶段补充验证的两项能力：

- Claude 只能在当前微信会话工作区内写入、修改、删除文件。
- Claude 写入 `working/output_weixin/` 的文件会由桥接层自动发送回微信。

## 一、功能目标

权限目标是一档固定策略：

| 操作 | 当前 session 工作区 | 同级 session | 上级目录 | 项目根目录 | 系统目录 |
|---|---|---|---|---|---|
| 读取 | 允许 | 允许 | 允许 | 允许 | 允许 |
| 写入 | 允许 | 禁止 | 禁止 | 禁止 | 禁止 |
| 修改 | 允许 | 禁止 | 禁止 | 禁止 | 禁止 |
| 删除 | 允许 | 禁止 | 禁止 | 禁止 | 禁止 |

这样 AI 可以完成完整任务，也可以读取必要上下文，但不能污染其他会话、项目目录、临时数据目录或系统目录。

## 二、目录约定

运行时默认数据目录：

```text
.tmp/wechat-integration-test/
  bot_token.txt
  bridge-data/
    relay.sqlite
  workspaces/
    session-xxxxxxxx/
      incoming/
      working/
        output_weixin/
      output/
```

当前会话工作区是 `workspaces/session-xxxxxxxx/`。AI 的可写范围只包含这个 session 目录本身及其子目录。

`working/output_weixin/` 是自动发送目录。AI 需要把希望发给微信用户的文件写到这里。

## 三、权限实现要点

主要逻辑在 `test/features/01-claude-dialogue/claude/permissions.ts`。

- `Read`、`Glob`、`Grep`、`LS`、`WebSearch`、`WebFetch` 等读取类工具默认允许。
- `Write`、`Edit`、`MultiEdit`、`NotebookEdit` 只能操作当前 session 工作区内的路径。
- `Bash` 会分析命令是否包含写入、修改、删除行为；只读命令可以跨目录读取，写命令必须明确落在当前 session 工作区内。
- `AskUserQuestion`、`Task`、`Agent`、`EnterWorktree` 等会打断自动流程或引入额外代理的工具被禁用。
- 越界写入会返回类似 `Bash write targets must stay inside the current session workspace` 的拒绝信息。

Windows 上 Claude Agent SDK 的内置 sandbox 当前关闭，实际权限由 `canUseTool` 回调稳定控制。非 Windows 平台仍会传入 SDK sandbox，写入范围限制为当前 session 工作区。

关键兼容点：SDK 的允许结果必须包含 `updatedInput`。如果只返回 `{ behavior: "allow" }`，SDK 会抛出 `updatedInput` 相关的 ZodError，表现为工具调用被异常拒绝或微信回复为空。

## 四、自动发送实现要点

主要逻辑在 `test/features/04-bridge/output-weixin.ts` 和 `test/features/04-bridge/bridge.ts`。

流程如下：

1. Claude 处理用户消息。
2. Claude 如需发送文件，将文件写入当前 session 的 `working/output_weixin/`。
3. 桥接层先发送文本回复。
4. 桥接层扫描 `working/output_weixin/` 中未发送过的文件。
5. 文件上传到微信 CDN 后，通过微信消息接口发送给用户。
6. 发送成功后写入 `.sent.json`，避免下次重复发送。

图片类型按扩展名识别：

```text
.png .jpg .jpeg .gif .webp .bmp
```

其他扩展名按普通文件发送。

去重签名使用 `文件大小:mtimeMs`。同名文件内容更新后签名变化，会再次发送；未变化则不会重复发送。

如果上传或发送失败，文件不会被标记为已发送，后续处理仍可重试。

## 五、自动化测试

推荐测试命令：

```powershell
cmd.exe /d /s /c npm.cmd test -- test/features/01-claude-dialogue/feature-01.test.ts test/features/04-bridge/feature-04.test.ts test/features/05-message-orchestration/feature-05.test.ts
```

本轮通过结果：

```text
3 files passed
93 tests passed
```

相关用例：

- `feature-01.test.ts` 覆盖权限策略、Bash 写入目标识别、SDK `updatedInput` 兼容。
- `feature-04.test.ts` 用例 14 覆盖“去网上照一张猫的图发我”，验证 `cat.png` 自动按图片发送。
- `feature-04.test.ts` 用例 15 覆盖“用python计算pi^pi,发我%.5e的结果”，验证 `pi-result.txt` 自动按文件发送且不会重复发送。

## 六、微信实测步骤

启动桥接：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge-daemon.ps1
```

保持终端打开，然后在微信里发送：

```text
去网上照一张猫的图发我
```

预期：

- AI 可以联网获取或生成猫图相关文件。
- 文件写入当前 session 的 `working/output_weixin/`。
- 微信收到文本回复。
- 微信随后收到图片文件。

继续发送：

```text
用python计算pi^pi,发我%.5e的结果
```

预期：

- AI 可以在当前 session 工作区内创建临时 Python 脚本或结果文件。
- 结果应为 `3.64159e+01`。
- 如果 AI 选择写文件到 `working/output_weixin/`，微信会自动收到该文件。
- AI 不需要，也不应该请求用户确认权限。

## 七、微信实测结论

本轮微信实测结果：

| 操作 | 结果 |
|---|---|
| 读取当前工作区 | 成功 |
| 读取同级 session | 成功 |
| 读取上级 `.tmp/wechat-integration-test/` | 成功 |
| 读取项目根目录 | 成功 |
| 写入当前工作区 | 成功 |
| 修改当前工作区文件 | 成功 |
| 删除当前工作区文件 | 成功 |
| 写入同级 session | 被拒绝 |
| 写入上级目录 | 被拒绝 |
| 写入项目根目录 | 被拒绝 |
| 删除同级、上级、项目根目录文件 | 被拒绝 |

最终判定：权限策略满足“可读外部、只写当前会话工作区”的要求；文件自动发送链路已通过微信实测。

## 八、排查日志

常用日志：

```text
.tmp/claude-permissions.jsonl
.tmp/claude-sdk-events.jsonl
.tmp/bridge-daemon.out.log
.tmp/bridge-daemon.err.log
.tmp/quote-listener.jsonl
```

排查建议：

- 如果工作区内写入也被拒绝，先看 `.tmp/claude-sdk-events.jsonl` 是否有 `updatedInput` / ZodError。
- 如果越界写入没有被拒绝，检查 `.tmp/claude-permissions.jsonl` 中对应工具的 `decision` 和目标路径。
- 如果文件没有发到微信，检查 `working/output_weixin/` 是否真的有文件。
- 如果文件只发了一次，检查 `working/output_weixin/.sent.json`，这通常是去重生效。
- 如果启动失败并提示找不到 `bot_token.txt`，需要重新扫码登录或恢复 `.tmp/wechat-integration-test/bot_token.txt`。

## 九、当前边界

- 权限策略依赖 SDK 工具调用层拦截，不阻止项目自身桥接代码读写运行时数据库和日志。
- 自动发送只扫描 `working/output_weixin/` 的普通文件，不递归发送子目录。
- 自动发送发生在文本回复之后；如果用户希望“只发文件不发文字”，需要在 prompt 层另行约束。
- 当前禁用了会中断自动流程的提问工具，因此 AI 遇到权限不足时应直接报告失败，而不是请求用户授权。
