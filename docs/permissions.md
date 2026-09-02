# Agent 权限模型详解

本文档完整说明 WeChat Claude 的 Claude Agent SDK 权限层：它允许什么、拒绝什么、判定在哪里发生、为什么这样设计。面向想理解或调整权限行为的工程师。

权限全部**硬编码**在 `src/features/01-claude-dialogue/claude/permissions.ts`，唯一入口是 `createClaudePermissionPolicy(cwd)`。前端管理面板暂未开放权限配置（可配置化的可行性评估见文末）。

## 1. 设计目标

微信对话是**无人值守**场景：用户发消息 → AI 自主完成任务 → 回复。中间没有任何人在终端前确认"允许执行这条命令吗"。因此权限层的目标是：

- **该自主的自主**：读文件、搜索、联网查资料、生成文档，全部直接放行，不打断流程；
- **不该自主的明确拒绝**：一切"写出会话工作区"的操作、需要人机交互的工具、不可逆的破坏性命令；
- **拒绝要可自我修正**：deny 消息会返回给模型（`interrupt: false`），模型读到原因后通常自行换路径（比如改写到工作区内），对话不中断。

## 2. 权限层在链路中的位置

```
微信消息 → bridge 预处理 → ClaudeSession.query()
                              ├─ settingSources: []      ← 不加载用户全局 ~/.claude 配置
                              ├─ allowedTools            ← 预批准列表（见 §3.2）
                              └─ canUseTool(tool, input) ← 每次工具调用的判定回调
```

两个关键点（`session.ts:41-105`）：

1. **SDK 配置隔离**：`settingSources: []` 使 SDK 完全不读宿主机的 `~/.claude`（无用户级 settings、无用户级 MCP、无历史权限批准）。权限行为只由本仓库代码决定，与机器上是否装过 Claude Code 无关。
2. **两级防线**：`allowedTools` 是 SDK 的预批准列表（列内工具不再进回调）；`canUseTool` 是每调用的最终裁判。两者都来自 `createClaudePermissionPolicy(session.cwd)`，策略对象按会话创建，以**会话工作区**为边界。

**工作区**：每个微信会话对应 `.wechat-claude/workspaces/session-<id>/`，内含 `working/`（工作目录）、`output_weixin/`（待发回微信的产出）、`skills/` 与 `tools/`（会话创建时播种的技能文件与 `preprocess.py`）。写入限制的全部含义就是"必须落在这棵目录树里"。

## 3. 工具判定规则

`canUseTool` 按工具名分五类判定，顺序即代码顺序（permissions.ts:98-119）：

### 3.1 始终拒绝（ALWAYS_DENY_TOOLS）

```
AskUserQuestion  ExitPlanMode                    （计划/交互类）
CronCreate  CronDelete  CronList  ScheduleWakeup （定时类）
Task  Agent  EnterWorktree  ExitWorktree         （子代理/工作树类）
```

这些工具要么需要前端交互（微信里没有确认 UI），要么会派生超出本权限模型约束的新进程/新工作树。命中即 deny，不进入后续判定。

### 3.2 始终允许（ALWAYS_ALLOW_TOOLS）

```
Read  Glob  Grep  LS            （读文件/搜索 —— 全盘，不限工作区）
WebSearch  WebFetch             （联网检索）
TodoWrite  TaskOutput  TaskGet  TaskList （自身任务簿，只读或内存态）
ListMcpResources  ReadMcpResource  Mcp
mcp__bridge__extract_document      （markitdown 提取文档）
mcp__bridge__render_pdf_pages     （PDF 页渲染成 PNG 到工作区）
mcp__bridge__read_scanned_pdf     （渲染+视觉转录，直接返回文本）
mcp__bridge__transcribe_image     （图片→描述+逐字转录）
mcp__bridge__extract_pdf_images   （抽取 PDF 内嵌图到工作区）
```

说明：

- **Read/Glob/Grep/LS 不限工作区是明确的设计决策**：AI 需要读取用户让它处理的任意路径文件（比如 `C:\Users\...\报告.docx`），读操作本身无破坏性。写入才受限。
- bridge 五工具在本列表直接放行，因为它们的处理器侧效果（渲染 PNG、抽图）本身就只写工作区目录（`working/pdf_pages/`、`working/pdf_images/`），无需重复判定。

### 3.3 写入工具（WRITE_TOOLS）

```
Edit  MultiEdit  Write  NotebookEdit
```

规则：从工具入参提取全部目标路径（`file_path`/`filePath`/`notebook_path`/`path` 等），**每一个**都必须位于会话工作区内：

- 全部在工作区内 → allow；
- 任一路径在工作区外 → deny（"Writes are only allowed inside the current session workspace."）；
- 提取不到路径 → deny（宁可错杀，不猜目标）。

路径先 `path.resolve` 归一化再比较（大小写不敏感），相对路径以会话 cwd 为基准，`..\` 逃逸自然被比较拦下。

### 3.4 Bash

最复杂的一类，按顺序过五道闸（`evaluateBashCommand`）：

1. **绝对拒绝模式**（BASH_ALWAYS_DENY_PATTERNS）：`git reset --hard`、`git checkout --`、`mkfs`、`format` —— 不可逆破坏，任何路径都不行。
2. **`dangerouslyDisableSandbox: true` 直接拒绝**：不允许模型自己关沙箱标记。
3. **可运行脚本规则**（见 §3.5）：命令里出现的 `python/node/deno/powershell -file` 脚本文件，本身必须位于工作区内。
4. **无写意图 → 放行**：命令不匹配任何写意图模式（纯读、运行、管道查看等），allow。
5. **有写意图 → 所有写目标必须在工作区内**：从重定向（`>`、`>>`）、shell 命令参数（`cp/mv/mkdir/rm/tee/Out-File/Set-Content/Remove-Item/...` 的目标参数）、下载输出（`curl -o` 等）、Python/JS 代码内写调用（`open(...,"w")`、`write_text`、`WriteFile`、`savefig` 等）中提取写目标路径；一个都提取不到 → deny（"必须显式写工作区本地路径"）；任一在区外 → deny。

**写意图模式**（BASH_WRITE_INTENT_PATTERNS，启发式正则）覆盖：重定向、PowerShell 写 cmdlet、copy/move/mkdir/touch/tee/rm/del/rmdir、curl/wget 带输出参数、Python `open(...,'w')` / `path().write_text` / `savefig` / `imwrite` / `tofile` / `urlretrieve`、Node `writeFile/createWriteStream` 等。

### 3.5 可运行脚本规则（为什么 tools/preprocess.py 在工作区里）

对 `python script.py`、`node script.js`、`deno run script.ts`、`powershell -file script.ps1` 这类命令，权限层会**打开脚本文件本身**继续检查（`evaluateRunnableScripts`）：

- 脚本文件必须在会话工作区内（区外脚本直接 deny —— 这就是会话创建时把 `scripts/preprocess.py` 播种到 `工作区/tools/` 的原因）；
- 必须是常规文件且 ≤ 2MB；
- 脚本**内容**同样过写意图检查：内含写出操作时，写目标路径必须在工作区内。

注意 `python -c "..."`（内联代码）不走此分支，由命令字符串本身的写意图检查兜底。

### 3.6 其余工具

不在以上任何名单中的工具 → deny（"Tool is not allowed in this permission mode"）。即默认拒绝，新增 SDK 工具不会自动获得权限。

## 4. 明确的边界与已知风险

- **Windows 下没有 OS 级沙箱**。整个权限层是应用层检查（`canUseTool` 回调 + 正则启发式），不是内核隔离。它对"模型的正常行为"是可靠的硬约束（写入工具路径逐一校验），但 Bash 的写意图识别是启发式：理论上存在构造出绕过正则的写命令的可能。无人值守部署时应以"运行账号本身无重要权限"为纵深防御。
- **Read 全盘开放**意味着 AI 可以读运行账号可读的任何文件（含 `.env`）。这是设计决策：桥接场景里用户经常要求处理任意位置的文档，读能力是核心功能。
- **删除类命令**（rm/del/Remove-Item）的**目标**必须在工作区内，但工作区内的删除是允许的（AI 清理自己的中间产物需要它）。
- **网络无限制**：WebSearch/WebFetch 放行，Bash 里的 `curl`（不带 `-o`）也放行。没有域名黑白名单。
- deny 一律 `interrupt: false`：模型收到拒绝原因后继续对话，倾向于自行改用合规方案（实测多数情况一步内自愈）。

## 5. 常见问题

**Q：AI 能读工作区外的文件吗？**
能。Read/Glob/Grep/LS 全盘开放。用户在微信里发来 `D:\xxx\报告.pdf` 的路径要求处理，直接可行。

**Q：能把文件从工作区外复制进来吗？**
能。`cp <区外路径> working/` 的写目标是区内 → 放行。这也是处理"用户指定本机路径文件"的常规路径之一。

**Q：能写到工作区外吗？**
不能。Edit/Write 路径校验、Bash 写目标校验都拦。产出文件放进 `output_weixin/`，由桥接层校验（Office 包完整性检查）后发回微信。

**Q：AI 能执行任意 pip/npm 安装吗？**
能（无写意图的命令放行，安装写的是全局/虚拟环境目录不在校验范围）。目前未对此设限。

**Q：怎么排查"AI 说它没权限"？**
设 `CLAUDE_PERMISSION_LOG=1` 重启，所有判定会落到 `logs/claude-permissions.jsonl`（工具名、入参摘要、allow/deny 原因），配合管理面板"Agent 处理流程"卡的工具调用记录定位。

**Q：修改权限后怎么生效？**
改 permissions.ts → `npm run build:app` → 重启服务。策略按会话即时创建，无需清理会话。（管理面板改模型等配置触发的会话重建同理。）

## 6. 关于"配置化"的评估（尚未实施）

权限规则本质是数据（工具名单单、正则列表）+ 一个入口函数。若要做成用户可在前端配置：

- **容易暴露**：三个名单（always-deny / always-allow / 写入工具）+ 若干开关（如"Read 限工作区""禁止联网"），都是可序列化进 config.json 的普通字段；会话对象在配置变化时整体重建，热生效路径已存在；
- **不建议暴露**：Bash 正则的逐条编辑——写意图识别是启发式集合，用户删错一条就出现工作区外写入的实洞，且极难自查；
- **风险提示**：当前权限是"代码审计过的固定策略"；一旦可配置，配置文件本身成为攻击面（诱导 AI 改配置放宽自己）。若实施，应只允许面板写、并保留最小集不可关闭。

## 7. 相关代码索引

| 内容 | 位置 |
| --- | --- |
| 策略入口与五类判定 | `src/features/01-claude-dialogue/claude/permissions.ts:89` |
| 名单与正则（修改权限改这里） | `permissions.ts:18-87` |
| 路径提取与工作区比较 | `permissions.ts:132-162` |
| Bash 判定 / 写意图 / 写目标提取 | `permissions.ts:164-500` |
| 可运行脚本检查 | `permissions.ts:264-341` |
| 策略接入 SDK 查询 | `src/features/01-claude-dialogue/claude/session.ts:41` |
| 工作区结构与播种 | `src/features/01-claude-dialogue/conversation/manager.ts`（findBundledAsset） |
| 判定日志 | `CLAUDE_PERMISSION_LOG=1` → `logs/claude-permissions.jsonl` |
