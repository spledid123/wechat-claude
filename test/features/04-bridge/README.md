# Feature 04: Bridge 集成（微信 <-> 预处理 <-> Claude <-> 微信）
> 状态：已完成并通过当前测试  |  测试：14/14 通过  |  日期：2026-06-15

---

## 一、功能概述

Feature 04 是整个项目当前阶段的“桥接层”。它把前面 3 个能力真正串起来：

1. Feature 02 接收并解析微信消息
2. Feature 03 对图片 / 文件做 OCR 或文本提取
3. Feature 01 管理会话、历史、Prompt，并调用 Claude
4. 最后再通过 Feature 02 把回复发回微信

它的职责不是“实现某一种单独能力”，而是负责把整条消息链路正确编排起来。

当前实现已经覆盖以下核心场景：

| 能力 | 说明 |
|------|------|
| 文本消息桥接 | 微信文本可直接进入 Claude，并把回复回发微信 |
| 会话自动续接 | 连续消息默认复用当前会话，`/new` 可主动开启新会话 |
| 历史上下文注入 | 最近若干轮对话会被格式化后注入 Prompt |
| 图片 / 文件接入 | 先下载，再做 OCR / 文本提取，再把结果提供给 AI |
| 直发语音接入 | 只把语音转写文本提供给 AI，不把 `.silk` 原文件传给 AI |
| 引用消息接入 | 支持把“被引用消息”的文字内容补全后交给 AI |
| 跨对话引用媒体 | 只要历史中保存过该媒体的已解析文本，就能在新对话中引用 |
| 引用媒体严格失败 | 若引用图片 / 文件 / 语音 / 视频但找不到解析文本，程序直接返回微信失败，不调用 AI |
| 指令消息处理 | 支持 `/new`、`/list`、`/switch`、`/help` |

本 Feature 当前面向“单 Bot、逐步联调、单活跃用户为主”的测试环境，已经满足现阶段微信侧引用能力的要求。

---

## 二、模块定位

### 2.1 在整套系统中的位置

```text
微信消息
  -> poller.ts 解析 ParsedMessage
  -> bridge.ts 编排处理
     -> SessionManager 解析 / 创建会话
     -> ConversationManager 记录消息与引用索引
     -> FilePreprocessor 处理图片 / 文件
     -> ClaudeManager 构造 Prompt 并调用 Claude
  -> sender.ts 发回微信
```

### 2.2 关键文件

```text
test/features/04-bridge/
├─ bridge.ts             # 核心桥接实现
├─ feature-04.test.ts    # 单元测试（全 mock）
└─ README.md             # 本文档

scripts/
├─ bridge-daemon.ts      # 后台常驻桥接进程
├─ bridge-test.ts        # 带控制台输出的联调入口
├─ bridge-offline.ts     # 不连微信的离线集成测试
└─ quote-listener.ts     # 只监听引用消息，不调用 AI
```

### 2.3 外部依赖

Feature 04 依赖前 3 个 Feature 的输出能力：

- Feature 01：会话管理、历史记录、Prompt 构造、Claude 调用
- Feature 02：微信收发、长轮询、CDN 下载、消息解析
- Feature 03：OCR 与文件文本提取

因此它是当前阶段最接近“真实可用链路”的一层。

---

## 三、核心接口

### 3.1 `SendFunc`

```ts
export type SendFunc = (params: {
  toUserId: string;
  contextToken: string;
  text: string;
}) => Promise<void>;
```

Bridge 不直接依赖具体的微信发送实现，而是通过 `SendFunc` 注入发送能力，便于：

- 单元测试中做 mock
- 离线调试时仅打印、不真实发送
- 在线守护进程中接入 `sendText()` 和长文本拆分

### 3.2 `Bridge`

```ts
class Bridge {
  constructor(
    claude: ClaudeManager,
    sm: SessionManager,
    cm: ConversationManager,
    pp: FilePreprocessor,
    sendText: SendFunc,
    botToken = "",
  )

  setBotToken(token: string): void

  handleMessage(
    msg: ParsedMessage,
    fromUserId: string,
    contextToken: string,
  ): Promise<string>
}
```

`handleMessage()` 是整个桥接层的主入口。它负责完成：

1. 指令识别
2. 会话解析
3. 引用内容解析
4. 入站记录
5. 媒体下载与预处理
6. PromptContext 组装
7. Claude 调用
8. 出站记录
9. 微信回发

---

## 四、输入与输出

### 4.1 输入：`ParsedMessage`

Bridge 接收的不是原始微信 JSON，而是 Feature 02 已经解析好的 `ParsedMessage`。当前桥接逻辑最关注这些字段：

```ts
interface ParsedMessage {
  raw: WeixinMessage;
  text: string;
  itemTypes: string[];
  voiceText?: string;
  fileName?: string;
  mediaRefs: Array<{
    downloadUrl: string;
    aesKey: string;
    itemType: string;
    msgId?: string;
  }>;
  quotedMessage?: {
    msgId?: string;
    text?: string;
    fromUser?: string;
    itemType?: string;
    fileName?: string;
    mediaKey?: string;
  };
}
```

### 4.2 输出

Bridge 的输出分成两层：

1. 返回值：`Promise<string>`，即本次最终回复文本
2. 副作用：通过 `sendText()` 发回微信，并把对话落库

---

## 五、完整处理流程

### 5.1 指令优先

进入 `handleMessage()` 后，首先检查是否是命令消息：

- `/new`
- `/list`
- `/switch <序号>`
- `/help`
- 以及部分中文别名

如果命中命令：

- 不调用 Claude
- 直接生成本地文本回复
- 通过微信发送

### 5.2 会话解析

若不是命令消息，则通过 `SessionManager.resolveSession(fromUserId)` 获取当前会话：

- 若当前存在未超时活跃会话，则继续使用
- 若当前会话超时，则先关闭再新建
- 若不存在活跃会话，则新建

会话工作目录结构由 Feature 01 创建：

```text
session-xxxxxxxx/
├─ incoming/
├─ working/
│  └─ output_weixin/
└─ output/
```

### 5.3 引用内容解析

如果消息中包含 `quotedMessage`，Bridge 会优先尝试把“被引用消息的真实文字内容”解析出来。

查找入口：

```ts
cm.findLatestMessageTextForUser(userId, {
  msgId,
  fileName,
  mediaKey,
  itemType,
})
```

查找顺序如下：

1. 先按 `msgId` 查
2. 再按 `mediaKey` 查
3. 再按 `fileName` 查
4. 若是图片引用，还允许回退到该用户最近一条图片解析文本

### 5.4 构造用户侧文本

Bridge 会把当前消息整理成最终的 `userText`。典型形式如下：

```text
[引用内容: 这张图片中的文字内容]
请帮我总结一下
```

如果是语音消息，还会额外注入语音转写：

```text
[语音转写: 我明天下午三点开会]
[引用内容: 上一条文件里的安排]
帮我整理成待办
```

这一步是整个 Feature 04 的关键，因为 AI 实际看到的是整理后的文字，而不是微信原始包。

### 5.5 记录入站消息

入站文本会先写入 `conversations` 表，随后 Bridge 会扫描原始 `item_list`，把每个 item 能提取出的文本写入 `message_text_index`：

- 文本：保存文本本身
- 语音：保存转写文字；若无转写则记为 `[语音]`
- 图片：保存占位 `[图片]`
- 文件：保存文件名；若后续提取到正文，再用真实文本覆盖
- 视频：保存占位 `[视频]`

这里的 `message_text_index` 是“引用能力”的基础设施。

### 5.6 媒体下载与预处理

对需要附带媒体内容的消息，Bridge 会遍历 `msg.mediaRefs`：

1. 调用 `downloadFromCdn()` 下载到当前会话的 `incoming/`
2. 调用 `FilePreprocessor.process()` 处理文件
3. 把提取结果填入 `PromptContext.files`
4. 若拿到了有效文本，则把该文本再写回 `message_text_index`

### 5.7 PromptContext 组装

Bridge 最终组装出：

```ts
const ctx: PromptContext = {
  userText,
  historyText,
  sessionSummary,
  files,
};
```

其中：

- `userText`：当前消息整理后的主文本
- `historyText`：最近 6 条消息格式化后的历史
- `sessionSummary`：上一段已关闭会话的摘要
- `files`：提取后的附件内容列表

这些数据随后交给 Feature 01 的 `prompt-builder.ts` 生成真正发送给 Claude 的 Prompt。

### 5.8 Claude 调用与回发

当 PromptContext 准备好后：

1. `ClaudeManager.processMessage()` 生成系统提示词和用户提示词
2. Claude 返回文本结果
3. Bridge 将结果写入 `conversations`
4. `SessionManager.incrementMessageCount()` 更新消息计数
5. 调用 `sendText()` 把结果发回微信

若 Claude 返回空文本，则兜底为：

```text
(empty response)
```

---

## 六、当前行为规则

这一节是 Feature 04 当前最重要的“行为约定”。

### 6.1 直发文本

行为最简单：

- 直接作为 `userText`
- 记录对话
- 调 Claude
- 回微信

### 6.2 直发图片 / 文件

行为如下：

1. 下载原文件
2. 调用 OCR / markitdown / 文本读取
3. 把提取结果作为 `files` 提供给 AI
4. 同时保留用户文字描述（如“帮我总结这个文件”）

若预处理失败：

- 当前实现不会阻断主流程
- 会在 `files[].preprocessingError` 中注明失败原因
- AI 仍会收到当前用户文本和错误描述

也就是说，直发媒体的失败策略是“可降级继续”。

### 6.3 直发语音

直发语音是本轮修正后的重点规则：

1. 从微信消息中读取语音转写文本
2. 把转写内容写入 `userText`
3. 不把 `.silk` 文件作为附件传给 AI
4. 也不会额外调用文件预处理器去处理 `.silk`

这是通过 `shouldAttachMedia()` 控制的：

- 当消息只有一个 `voice` item 时，返回 `false`
- 因此 `msg.mediaRefs` 不会进入附件处理流程

当前语音策略的核心原则是：

> AI 只需要“语音转写后的文字”，不需要原始语音文件。

### 6.4 不屏蔽“看起来像占位符”的真实语音内容

语音转写不再对类似以下文本做特殊过滤：

- `我发了一段语音`
- `[语音]`

只要微信给到的转写文本就是这个内容，就按字面原样保留并提供给 AI。

也就是说，程序不再猜测“这是不是假的转写”，只负责忠实透传。

### 6.5 引用纯文本

若用户引用的是普通文本消息：

- 优先取索引中的真实文本
- 如果索引中没有，再回退到 `quotedMessage.text`

因此文本引用通常是最稳的。

### 6.6 引用图片 / 文件 / 语音 / 视频

这是本轮联调后定下来的严格规则：

1. 如果引用的是媒体消息，Bridge 必须先找到该消息已解析好的文字内容
2. 找到了，才允许把它注入当前 `userText`
3. 找不到，就直接返回微信失败提示
4. 不调用 AI
5. 不写入当前轮 `conversations`

对应失败文案示例：

- `引用的图片内容未能成功解析，无法提供给 AI。请直接重新发送原始图片。`
- `引用的文件内容未能成功解析，无法提供给 AI。请直接重新发送原始文件。`
- `引用的语音内容未能成功解析，无法提供给 AI。请直接重新发送原始语音。`

这条规则与“直发媒体失败可降级”不同：

- 直发媒体：允许降级给 AI
- 引用媒体：不允许降级；解析失败就拦截

### 6.7 跨对话引用

当前实现已经支持“新对话中引用旧对话的媒体内容”，前提是旧消息的解析文本已经被保存到 `message_text_index`。

可用的跨对话匹配依据包括：

- `msgId`
- `mediaKey`
- `fileName`

其中：

- 文件跨对话引用主要依赖 `fileName`
- 语音 / 图片 / 视频优先依赖 `msgId` 或 `mediaKey`

因此，Feature 04 现在的设计不是“跨对话只引用文字”，而是：

> 不论同对话还是新对话，只要引用的是媒体，就尽量回到历史索引里找它对应的真实文本。

### 6.8 图片引用的兜底策略

图片在部分微信引用场景下，原始引用信息不一定足够完整。因此当前实现额外保留了一个“最近图片文本”兜底：

- 若当前引用 `itemType === "image"`
- 且没有 `msgId / mediaKey / fileName` 精确命中
- 可回退到该用户最近一条图片解析文本

这是为了提高微信图片引用在实际联调中的可用性。

---

## 七、Prompt 组装细节

### 7.1 System Prompt 里会告诉 AI 什么

Feature 01 的 `buildSystemPromptAppend(ctx)` 会注入以下信息：

- 这是一个连接到微信的 AI relay bot
- 回复应使用简体中文
- 回复尽量简洁、适合微信聊天
- 当前工作目录结构说明
- 上一段已关闭会话摘要
- 用户自定义指令（若有）
- 文件列表与预处理状态
- 最近会话历史

当存在附件时，还会明确告知 AI：

- 不要自行读取或处理 PDF / DOCX / 图片等原始文件
- 文件正文已经在用户消息里提供
- 如果文件提取失败，只需告知用户，不要尝试用 Bash 自救

### 7.2 User Message 里会放什么

`buildUserMessage(ctx)` 的拼装顺序是：

1. 先放附件文本内容
2. 再放当前用户文本

典型示例：

```text
[File: report.pdf]
Content:
这里是从 PDF 中提取出来的正文...

[语音转写: 帮我总结一下]
[引用内容: 这是上一条图片中的 OCR 结果]
请按三点列出重点
```

这也是为什么 Bridge 层必须先把引用内容和语音内容整理好，再交给 ClaudeManager。

---

## 八、数据落库设计

### 8.1 `conversations`

记录正式对话历史，用于：

- 上下文回放
- 调试追踪
- 会话恢复

Bridge 每完成一轮真实对话，通常会写入两条：

1. 用户入站消息
2. AI 出站回复

### 8.2 `message_text_index`

这是当前引用能力的核心索引表。

保存字段包含：

- `msg_id`
- `user_id`
- `session_id`
- `from_user_id`
- `item_type`
- `file_name`
- `media_key`
- `text_content`
- `created_at`

它的职责不是保存“整条对话”，而是保存“某条微信消息最终可供引用的文字内容”。

Bridge 会在两个时机更新它：

1. 入站消息刚收到时，先按 item 能看到的文字先保存一次
2. 媒体文件完成 OCR / 提取 / 转写后，再用真实文本覆盖或补充

这使得后续引用可以跨会话查回真正的文本内容。

### 8.3 兼容旧库

数据库初始化时，`ensureMessageTextIndexColumns()` 会自动检查并补齐：

- `file_name`
- `media_key`

因此即使旧数据库最早没有这两个字段，也能在启动时平滑升级。

---

## 九、命令支持

Feature 04 当前内置以下命令：

| 命令 | 作用 |
|------|------|
| `/new` | 关闭当前会话并新建一段对话 |
| `/list` | 查看最近会话存档 |
| `/switch <序号>` | 切换到指定历史会话 |
| `/help` | 查看帮助 |

也支持部分中文别名：

- `新对话`
- `开始新对话`
- `对话存档`
- `存档`
- `切换对话 <序号>`
- `帮助`

注意：

- 命令由 Bridge 本地处理
- 命令不进入 Claude
- 命令回复也会直接发回微信

---

## 十、错误处理策略

### 10.1 当前错误分层

| 场景 | 当前策略 |
|------|----------|
| 直发图片 / 文件预处理失败 | 不阻断；把失败信息附给 AI |
| 直发语音无媒体处理 | 只使用转写文本 |
| 引用媒体找不到解析文本 | 直接返回微信失败，不调用 AI |
| CDN 下载失败 | 当前轮附件标记失败，AI 仍可收到其他文本上下文 |
| Claude 返回空字符串 | 回复 `(empty response)` |
| 微信发送失败 | 由外层发送函数记录日志；Bridge 本身不重试 |

### 10.2 为什么引用媒体必须严格失败

这是本轮联调后刻意收紧的策略。

原因是：

1. 用户已经明确引用了某个具体媒体
2. 如果程序只把“文件名”或“[图片]”交给 AI，AI 会误以为自己已经拿到了内容
3. 这会制造“看似成功、实际上内容缺失”的假阳性

因此当前设计宁可显式失败，也不允许带着缺失上下文进入 AI。

---

## 十一、测试覆盖

`feature-04.test.ts` 当前共覆盖 14 条用例。

### 11.1 文本与基础桥接

| 用例 | 说明 |
|------|------|
| 1 | 纯文本可路由到 Claude，并回发微信 |
| 2 | 入站与出站消息会写入 `conversations` |

### 11.2 文件 / 图片 / 会话基础能力

| 用例 | 说明 |
|------|------|
| 3 | 图片路径存在时可进入 Claude |
| 4 | OCR 失败时仍可继续回复 |
| 5 | 不支持文件类型时仍可继续回复 |
| 6 | 历史上下文可通过会话日志传递 |
| 7 | 同一用户连续消息复用同一活跃会话 |
| 8 | `/new` 会关闭旧会话并创建新会话 |

### 11.3 语音与引用能力

| 用例 | 说明 |
|------|------|
| 9 | 直发语音会记录转写并正常回复 |
| 9b | 直发语音保留字面转写，且不会把 `.silk` 作为附件交给 AI |
| 10 | 同会话引用语音可取回索引中的真实文本 |
| 11 | 新对话中引用媒体，可跨对话解析历史文本 |
| 12 | 新对话中引用文件，可按文件名取回提取后的正文 |
| 13 | 引用媒体若没有已保存文本，会在到达 AI 前直接失败 |

### 11.4 测试命令

```bash
npm test -- test/features/04-bridge/feature-04.test.ts
```

若要和相关依赖模块一起回归，可运行：

```bash
npm test -- test/features/01-claude-dialogue/feature-01.test.ts test/features/02-wechat-connectivity/feature-02.test.ts test/features/04-bridge/feature-04.test.ts
```

---

## 十二、联调入口

### 12.1 后台守护进程

```bash
npx tsx scripts/bridge-daemon.ts
```

特点：

- 常驻监听微信
- 不带交互式 REPL
- 适合后台稳定联调
- 长文本会自动拆段发送

### 12.2 带控制台输出的联调脚本

```bash
npx tsx scripts/bridge-test.ts
```

特点：

- 控制台输出更详细
- 会打印引用信息、item keys、处理状态
- 适合人工观察链路问题

### 12.3 离线集成测试

```bash
npx tsx scripts/bridge-offline.ts
```

特点：

- 不连接微信
- 便于验证桥接层与 Claude / 预处理 / 数据库的串联逻辑

### 12.4 仅监听引用

```bash
npx tsx scripts/quote-listener.ts
```

特点：

- 只看微信原始 `ref_msg`
- 不调用 Claude
- 不发送回复
- 适合排查引用结构本身的问题

---

## 十三、当前边界与已知限制

### 13.1 当前不是生产级多用户会话模型

`SessionManager` 当前使用“全局活跃会话”查询方式，适合当前单 Bot、逐步联调、单用户主场景。

这意味着：

- 当前文档描述的是“现有测试实现”
- 不是“面向多用户并发生产环境”的最终架构

若后续进入多用户稳定运营阶段，会话选择策略需要继续细化。

### 13.2 当前引用能力依赖文本索引，而不是原始媒体再解析

Bridge 对引用媒体的处理思路是：

- 优先复用历史已保存的解析结果
- 而不是在用户每次引用时重新去下载、OCR、转写一次旧媒体

这样可以减少重复计算，也更贴合微信引用消息本身的信息缺口。

### 13.3 当前不处理权限与自动回传文件

以下内容不属于 Feature 04 当前已完成范围：

- Claude 生成文件后的权限策略
- 是否自动把 `output_weixin/` 中的文件发回微信
- 更复杂的工具调用约束

这些属于后续 Feature 的设计议题。

---

## 十四、结论

截至 2026-06-15，Feature 04 已经完成当前阶段最关键的桥接闭环，并在微信联调中满足以下要求：

1. 普通消息可以稳定转给 AI 并回复
2. 直发语音只向 AI 提供文字，不传原始语音文件
3. 同对话与新对话中的引用媒体，都尽量回到历史索引中查找真实文本
4. 若引用媒体没有真实文本，则直接失败返回微信，不允许把缺失内容伪装成交给 AI

这意味着测试 4 的“桥接 + 引用 + 语音 + 跨对话引用”主线目标已经达成，可以作为后续权限控制、文件自动回传等功能的稳定基础。
