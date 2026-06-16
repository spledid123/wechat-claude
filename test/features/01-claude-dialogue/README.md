# Feature 01: Claude Code 对话及对话记录管理

> 状态：✅ 已完成  |  测试：55/55 通过  |  日期：2026-06-15

---

## 一、功能概述

实现程序通过 `@anthropic-ai/claude-agent-sdk` 与 Claude Code（DeepSeek V4 Pro）进行流式对话，并将所有对话记录持久化到 SQLite 数据库。支持多会话切换、历史上下文注入、会话超时管理等完整生命周期。

### 核心能力

| 能力 | 说明 |
|------|------|
| AI 对话 | 通过 Claude Agent SDK `query()` 流式调用，支持 system prompt 注入 |
| 对话存档 | 每条消息（方向/内容/时间/序号）持久化到 SQLite |
| 会话管理 | 创建 / 恢复 / 切换 / 超时关闭 / 删除（含工作区目录清理） |
| 历史上下文 | 最近 N 条消息格式化为 `用户: ... / 助手: ...` 注入 AI 上下文 |
| 并发控制 | 信号量排队，同一时间只允许 1 个 AI 请求 |
| 提示词构建 | 系统提示 + 会话摘要 + 历史 + 文件 + 多气泡指令动态组装 |

---

## 二、模块架构

```
┌─────────────────────────────────────────────────────┐
│                   ClaudeManager                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Session A│  │ Session B│  │ Session C│  (Map)   │
│  │ (Claude) │  │ (Claude) │  │ (Claude) │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │             │             │                  │
│  ┌────┴─────────────┴─────────────┴────┐            │
│  │         Semaphore (max=1)            │            │
│  └──────────────────────────────────────┘            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 SessionManager                       │
│  ┌────────────────────────────────────────────┐     │
│  │  SQLite: sessions / users                  │     │
│  │  Disk:   workspaces/{incoming,working,     │     │
│  │           output_weixin,output}/            │     │
│  └────────────────────────────────────────────┘     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│              ConversationManager                     │
│  ┌────────────────────────────────────────────┐     │
│  │  SQLite: conversations                      │     │
│  │  Format: "用户: xxx\n助手: yyy"             │     │
│  └────────────────────────────────────────────┘     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│               Prompt Builder                         │
│  System Appends + User Messages + Multi-Bubble       │
└─────────────────────────────────────────────────────┘
```

---

## 三、数据库 Schema

### 3.1 users — 微信用户

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| wechat_user_id | TEXT UNIQUE | `o9cq800kum_xxx@im.wechat` |
| nickname | TEXT | 微信昵称（可选） |
| first_seen_at | TEXT | 首次出现时间 |
| last_active_at | TEXT | 最后活跃时间 |

### 3.2 sessions — 会话

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID v4 |
| user_id | INTEGER FK | 关联 users |
| from_user_id | TEXT | 微信用户 ID |
| context_token | TEXT | 微信对话 token（回复必带） |
| claude_session_id | TEXT | Claude 内部 session ID |
| cwd | TEXT | 工作区目录路径 |
| status | TEXT | `active` / `closed` |
| summary | TEXT | AI 生成的会话摘要 |
| tool_mode | TEXT | 工具权限模式 |
| message_count | INTEGER | 消息计数 |
| closed_reason | TEXT | 关闭原因 |
| created_at / last_active_at / closed_at | TEXT | 时间戳 |

**状态流转：**
```
active ──(用户切换/超时/手动)──→ closed
closed ──(deleteSession)───────→ 级联删除 conversations + 磁盘目录
```

### 3.3 conversations — 对话记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| session_id | TEXT FK | 关联 sessions (CASCADE) |
| user_id | INTEGER FK | 关联 users |
| seq_in_session | INTEGER | 会话内序号 (1, 2, 3...) |
| direction | TEXT | `inbound`（用户发）/ `outbound`（AI 回） |
| message_type | INTEGER | 1=文本, 2=图片, 3=语音, 4=文件, 5=视频 |
| text_content | TEXT | 文本内容 |
| file_refs | TEXT | 关联文件引用 |
| context_token | TEXT | 微信 context_token |
| created_at | TEXT | 创建时间 |

### 3.4 turns — 消息防抖缓冲（Feature 6 预留）

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | TEXT FK | 关联 sessions |
| normalized_text | TEXT | 合并后文本 |
| raw_payload_json | TEXT | 原始消息 JSON |
| status | TEXT | `buffered` → `merged` → `discarded` |

### 3.5 schema_migrations — 迁移版本

| 字段 | 类型 | 说明 |
|------|------|------|
| version | INTEGER PK | 迁移编号 |
| name | TEXT | 文件名 |
| applied_at | TEXT | 执行时间 |

---

## 四、模块接口

### 4.1 ClaudeSession

包装 `@anthropic-ai/claude-agent-sdk` 的单个对话实例。

```typescript
class ClaudeSession {
  constructor(options: {
    sessionId: string;    // 唯一标识
    cwd: string;          // 工作目录
    model?: string;       // 模型名（默认 sonnet）
    maxTurns?: number;    // 最大工具调用轮数
  })

  // 发送用户消息，流式接收 AI 回复
  querySimple(
    userText: string,
    systemAppend?: string,
    mcpServers?: Record<string, unknown>,
  ): Promise<ClaudeQueryResult>

  cancel(): void                    // 中止当前查询
  getIsProcessing(): boolean        // 是否正在处理
  getLastResult(): ClaudeQueryResult | null
}

interface ClaudeQueryResult {
  text: string;         // AI 回复文本
  turnCount: number;    // assistant 消息数
  sessionId: string;    // 会话 ID
}
```

### 4.2 ClaudeManager

会话池 + 并发控制。

```typescript
class ClaudeManager {
  constructor(maxConcurrent?: number)  // 默认 1

  getOrCreateSession(spec: SessionSpec): ClaudeSession
  processMessage(spec: SessionSpec, ctx: PromptContext): Promise<ClaudeQueryResult>
  cancelSession(sessionId: string): void
  closeSession(sessionId: string): void
  shutdown(): void
}
```

### 4.3 SessionManager

会话数据库生命周期。

```typescript
class SessionManager {
  constructor(workspaceBase: string, sessionTimeoutMinutes?: number)  // 默认 60min

  resolveSession(fromUserId: string): SessionRecord   // 找活跃/超时关/新建
  createSession(fromUserId: string): SessionRecord    // 创建+建工作区
  closeSession(sessionId: string, reason: string): void
  deleteSession(sessionId: string): boolean           // 级联删除
  updateContextToken(sessionId, token): void
  updateClaudeSessionId(sessionId, csid): void
  getContextToken(sessionId): string
  saveSummary / getSummary / getLastClosedSessionSummary
  incrementMessageCount(sessionId): void
  listActiveSessions / listAllSessions
}
```

### 4.4 ConversationManager

消息记录与查询。

```typescript
class ConversationManager {
  addMessage(record: ConversationRecord): number   // 返回 row id
  getHistory(sessionId: string, limit?: number): HistoryEntry[]
  getContextMessages(sessionId: string, maxMessages?: number): string
  pruneOldConversations(days?: number): number     // 返回删除数
}
```

### 4.5 Prompt Builder

```typescript
buildSystemPromptAppend(ctx: PromptContext): string     // 系统提示
buildUserMessage(ctx: PromptContext): string            // 用户消息
buildMultiBubbleInstruction(): string                   // <<<MSG>>> 指令
MULTI_BUBBLE_SEPARATOR = "<<<MSG>>>"
MAX_BUBBLES = 4
```

**PromptContext 结构：**
```typescript
interface PromptContext {
  userText: string;
  sessionSummary?: string | null;    // 上段对话摘要
  historyText?: string;              // "用户: xxx\n助手: yyy"
  userPrompt?: string | null;        // 用户自定义指令
  files?: Array<{                   // 附件
    name: string;
    path: string;
    extractedText?: string;          // markitdown/OCR 提取
    transcribedText?: string;        // 语音转文字
    mimeType?: string;
  }>;
}
```

---

## 五、使用示例

```typescript
// 1. 初始化
await initializeDatabase("./data");
const sm = new SessionManager("./data/workspaces", 60);
const cm = new ConversationManager();
const claude = new ClaudeManager(1);

// 2. 获取或创建会话
const session = sm.resolveSession("user@im.wechat");

// 3. 记录用户消息
cm.addMessage({
  sessionId: session.id,
  userId: session.userId,
  direction: "inbound",
  messageType: 1,
  textContent: "帮我查一下天气",
});

// 4. 构建上下文并调用 AI
const historyText = cm.getContextMessages(session.id, 6);
const ctx: PromptContext = {
  userText: "帮我查一下天气",
  historyText,
  sessionSummary: sm.getLastClosedSessionSummary(),
};

const result = await claude.processMessage(
  { sessionId: session.id, cwd: session.cwd },
  ctx,
);

// 5. 记录 AI 回复
cm.addMessage({
  sessionId: session.id,
  userId: session.userId,
  direction: "outbound",
  messageType: 1,
  textContent: result.text,
});

// 6. 切换会话
sm.closeSession(session.id, "user_switched");
const newSession = sm.resolveSession("user@im.wechat");
// → 由于上一会话已关闭, resolveSession 会创建新会话
```

---

## 六、测试报告

### 单元测试：55 个用例，6 组全覆盖

| 分组 | 内容 | 用例数 |
|------|------|--------|
| Group A | 数据库初始化 & Migration | 8 |
| Group B | SessionManager CRUD | 16 |
| Group C | ConversationManager | 7 |
| Group D | ClaudeSession + Manager (Mock) | 13 |
| Group E | Prompt Builder | 10 |
| Group F | 端到端对话流程 | 1 |
| **合计** | | **55** |

运行方式：
```bash
npm test
```

### 集成测试：真实 Claude API 多轮对话

```bash
npx tsx scripts/integration-test.ts
```

验证流程：
```
Session 1 (d3825888): 你好 → 你是？ → 每句话加喵 → 1+1=? → 你是什么模型？
Session 2 (82e889e0): 你好 → 怎么评价DeepSeek？
Session 1b (907dfd3a): 你知道好姐妹吗？ (继承 Session 1 上下文)
```

结果：
- 3 个会话 / 16 条消息完整存档
- 上下文切换正确（S2 不带喵，S1b 恢复喵）
- 数据库持久化验证通过

### SDK 连通性

```bash
node scripts/check-claude-sdk.js
```
→ ✅ 真实调用返回 `SDK_OK`

---

## 七、关键设计决策

| 决策 | 理由 |
|------|------|
| sql.js (WASM) 而非 better-sqlite3 | 零原生依赖，Electron 打包友好 |
| 信号量并发控制 (max=1) | DeepSeek 服务端限制，同时也可以避免上下文混乱 |
| JS `Date.now()` 计算超时而非 SQL `strftime` | Windows 上 `strftime('%s')` 行为不一致 |
| `vi.mock()` 而非 vitest alias | 动态 `import()` 的 mock 只能用 `vi.mock()` |
| 每个 session 独立工作区目录 | AI 的 Bash/Write 只能操作自己的 workspace |
| 对话历史注入限制 6 条/500 字 | 控制 token 消耗，保留足够上下文 |
| DB 行级时间戳用 `datetime('now')` | 避免 JS 和 SQLite 时间不一致 |

---

## 八、文件清单

```
test/features/01-claude-dialogue/
├── README.md                    ← 本文档
├── feature-01.test.ts           ← 55 个单元测试
├── db/
│   ├── connection.ts            ← sql.js 初始化/迁移/查询助手
│   └── migrations/
│       └── 001_initial.sql      ← 初始 schema (users/sessions/conversations/turns)
├── claude/
│   ├── types.ts                 ← 共享类型
│   ├── session.ts               ← ClaudeSession: SDK 包装
│   └── manager.ts               ← ClaudeManager: 会话池+并发
├── session/
│   └── manager.ts               ← SessionManager: DB 会话生命周期
├── conversation/
│   └── manager.ts               ← ConversationManager: 消息记录
└── prompt-builder.ts            ← 提示词构建

scripts/
├── check-claude-sdk.js          ← SDK 连通性验证
└── integration-test.ts          ← 真实 API 多轮对话集成测试
```
