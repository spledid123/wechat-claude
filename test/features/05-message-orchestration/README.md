# Feature 05: 消息编排

状态：已完成并通过真机联调  
测试：7/7 通过  
日期：2026-06-16

---

## 一、功能目标

Feature 05 解决的不是“AI 会不会回答”，而是“微信消息如何更像真实聊天那样进入 AI、再自然地回到微信”。

当前落地了 3 个核心能力：

1. 消息防抖合并
2. “正在输入”状态指示
3. `<<<MSG>>>` 多气泡拆分

整体链路如下：

```text
微信消息
  -> 编排器缓冲 / 合并
  -> Bridge.handleMessages()
  -> Claude
  -> 按 <<<MSG>>> 拆成多气泡
  -> 微信发送
```

---

## 二、当前行为规则

### 2.1 防抖窗口

- 纯文本消息：3 秒
- 含媒体消息：5 秒
- 最长缓冲时间：15 秒

同一用户、同一会话内，短时间连续发送的消息会先进入同一批次；窗口结束后，再统一进入一次 AI 处理。

### 2.2 不进入防抖的命令

以下命令直接交给 Bridge，不进入缓冲：

- `/new`
- `/help`
- `/continue`

### 2.3 Typing 生命周期

批次真正开始 flush 时：

1. 启动 typing
2. 调用 `Bridge.handleMessages()`
3. 发送回复
4. 停止 typing

当前实现中：

- typing 启动时会立刻发送第一次状态
- 之后每 5 秒续发一次
- 如果微信侧 `getconfig` 没返回 `typing_ticket`，则自动降级为不发送 typing，但不影响主流程

### 2.4 多气泡拆分

如果 AI 回复中包含：

```text
<<<MSG>>>
```

桥接层会：

1. 按分隔符拆段
2. 去掉空白段
3. 最多保留前 4 段
4. 逐条发送到微信

如果单个气泡本身过长，仍会继续走微信侧的长文本拆分逻辑。

---

## 三、核心实现

### 3.1 `MessageOrchestrator`

文件：

- [orchestrator.ts](/d:/1/wechat_claude/test/features/05-message-orchestration/orchestrator.ts)

职责：

- 接收单条微信消息
- 判断是否命令直达
- 按“用户 + 会话”维度维护待 flush 批次
- 写入 `turns` 表记录 `buffered` / `merged`
- 调用 `Bridge.handleMessages()`
- 将 AI 回复拆成多气泡发送

### 3.2 脚本侧运行时辅助

文件：

- [bridge-runtime.ts](/d:/1/wechat_claude/scripts/bridge-runtime.ts)

职责：

- 创建真实微信文本发送函数
- 创建真实微信 typing 服务
- 统一给 live 入口复用

### 3.3 Live 入口

当前已经接入：

- [bridge-daemon.ts](/d:/1/wechat_claude/scripts/bridge-daemon.ts)
- [bridge-test.ts](/d:/1/wechat_claude/scripts/bridge-test.ts)

这两个入口现在都实际走 Feature 05，不再是旧版“消息一到就直接 `handleMessage()`”。

---

## 四、和前面 Feature 的关系

### 4.1 与 Feature 04

Feature 04 负责单轮桥接。  
Feature 05 在其上再加一层“消息编排器”，并通过 `Bridge.handleMessages()` 支持一批消息共用同一轮 AI 调用。

### 4.2 与 Feature 01

继续复用：

- `sessions`
- `conversations`
- `turns`

其中 `turns` 在本功能里首次被真正用来记录缓冲态和合并态，方便排障。

---

## 五、测试覆盖

自动化测试共 7 条：

1. 3 秒内连续文本会合并成一次 AI 处理
2. 含媒体消息使用 5 秒窗口
3. `/new` 不进入防抖，立即处理
4. typing 在 flush 前启动，结束后停止
5. `<<<MSG>>>` 会拆分，且最多 4 条
6. 拆分后的每个气泡都会单独发送
7. `IntervalTypingService` 启动时会立刻发送第一次 typing

运行命令：

```bash
npm test -- test/features/05-message-orchestration/feature-05.test.ts
```

联合回归：

```bash
npm test -- test/features/04-bridge/feature-04.test.ts test/features/05-message-orchestration/feature-05.test.ts
```

本轮最终回归结果：

- Feature 05：7/7 通过
- Feature 04 + 05：21/21 通过

---

## 六、真机联调结果

本轮已经完成真实微信环境联调，确认以下行为正常：

1. 文本消息进入防抖后能够正常 flush
2. 合并后的消息只触发一次 AI 处理
3. AI 回复能正常回到微信
4. `turns` 中能看到 `buffered` 和 `merged` 记录
5. `<<<MSG>>>` 拆分链路已接入 live 入口
6. `quote-listener` 不再吞掉正式消息

联调时实际验证到的一条记录：

- 入站：`用两句话`
- 出站：`你好，我是 Claude，可以帮你写代码、查问题、改文件，也可以陪你聊聊天。有什么想让我帮忙的，直接说就行～`

同时数据库中已确认存在：

- 一条 `buffered`
- 一条 `merged`
- 一条 inbound conversation
- 一条 outbound conversation

说明编排层、Bridge、AI、发送链路已经全部贯通。

---

## 七、本轮排查到的真实问题

### 7.1 `quote-listener` 抢消息

在联调阶段，曾出现“微信消息收到了，但程序不回复”的现象。

根因不是 Feature 05 本身，而是：

- `bridge-daemon.ts` 在拉 `getupdates`
- `quote-listener.ts` 也在拉 `getupdates`
- 两个消费者抢同一个微信消息流，导致调试监听先把消息消费掉

修复方式：

- `bridge-daemon.ts` 现在会自己顺手写引用调试日志到 `.tmp/quote-listener.jsonl`
- `quote-listener.ts` 改成只读日志查看器，不再直接轮询微信

这次修复后，正式桥接进程成为唯一消息消费者。

### 7.2 Typing ticket 缺失

当前代码已经接入真实 typing API，但微信侧在本次联调环境中没有返回 `typing_ticket`。

实际表现：

- 主消息链路不受影响
- typing 自动降级为禁用
- 日志中可见：`Typing disabled: getconfig did not return typing_ticket.`

所以：

- “代码链路已接好”是确认过的
- “微信界面是否显示正在输入”仍受平台侧返回值影响

---

## 八、相关文件

主要实现：

- [orchestrator.ts](/d:/1/wechat_claude/test/features/05-message-orchestration/orchestrator.ts)
- [feature-05.test.ts](/d:/1/wechat_claude/test/features/05-message-orchestration/feature-05.test.ts)
- [bridge-runtime.ts](/d:/1/wechat_claude/scripts/bridge-runtime.ts)
- [bridge-daemon.ts](/d:/1/wechat_claude/scripts/bridge-daemon.ts)
- [bridge-test.ts](/d:/1/wechat_claude/scripts/bridge-test.ts)
- [quote-debug.ts](/d:/1/wechat_claude/scripts/quote-debug.ts)
- [quote-listener.ts](/d:/1/wechat_claude/scripts/quote-listener.ts)

---

## 九、结论

Feature 05 现在已经不是“测试侧实现”，而是已经真正接入实时运行入口，并通过了自动化测试和真机联调。

当前可确认的结论是：

1. 消息防抖合并正常
2. `<<<MSG>>>` 多气泡拆分正常
3. live 入口已经走新链路
4. 引用调试工具不再抢正式消息
5. typing 代码链路正常，但是否显示仍取决于微信是否返回 `typing_ticket`
