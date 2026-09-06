# WeChat Claude

English | [简体中文](README.md)

WeChat Claude is a locally-run WeChat ↔ Claude bridge. It hands WeChat messages over to a Claude Agent for processing, then sends replies, generated files, or scheduled-task results back to WeChat. The production version runs as an Electron tray app and ships with a local admin panel.

This README is written for engineers taking over the project. End users of the packaged exe should read the [user guide](docs/user-exe-guide.md), architecture details are in [Architecture & Packaging](docs/architecture.md), and WeChat API details in [WeChat iLink Bot API Notes](docs/wechat-ilink-api.md). (Docs in `docs/` are currently Chinese only.)

> Most of the code in this project was written with AI assistance — primarily **GLM-5.3**, with some early commits by Claude (see Contributors).

## Current Status

- Production source lives in `src/`; core business modules are in `src/features/`.
- Local data is written to `.wechat-claude/` next to the program directory and is never committed to git.
- The Windows portable exe is built with `electron-builder`; artifacts land in `release/` and are not committed.

## Features

- **Two-way WeChat ↔ Claude Agent bridge**: QR-code login with a locally persisted token; handles text, voice (auto-transcribed), images, files and quoted messages.
- **A full agent, not just a chat model**: built on the Claude Agent SDK, with tool calling and per-session workspaces.
- **Multi-user sessions**: isolated context and workspace per WeChat sender.
- **Image understanding**: a vision channel (DeepSeek vision by default) with direct/separate modes — it can use a different provider and key than the main conversation.
- **Document parsing**: text extraction from PDF/Office documents (markitdown + pymupdf); scanned PDFs are transcribed page by page via vision (20-page default cap, extendable by the agent inside the workspace).
- **Document generation**: bundled docx/xlsx/pptx skills; generated files are sent back to WeChat automatically.
- **Scheduled tasks**: created in natural language with a draft-confirmation flow; executed on schedule with results delivered back to WeChat.
- **Quoted-message context**: quote your own or the AI's earlier messages to continue a thread; the quoted content is visible to the AI.
- **Local admin panel**: configure mode/model/API access and the vision channel in the browser; manage sessions; inspect per-sender raw message logs and a live agent-event stream.
- **Fully local data**: SQLite storage, size-based log rotation, configurable retention; Electron tray app + single-file Windows portable exe.

## Requirements & One-Click Setup

| Item | Requirement | How to install |
| --- | --- | --- |
| OS | Windows 10 (1709+) / Windows 11, x64 | — |
| Node.js | ≥ 20, 22 LTS recommended | `winget install OpenJS.NodeJS.LTS`, or download the LTS x64 installer from [nodejs.org](https://nodejs.org); verify with `node -v` |
| uv | any recent version | `winget install astral-sh.uv`, or run `irm https://astral.sh/uv/install.ps1 \| iex` in PowerShell |
| Python | no manual install | a managed CPython is downloaded automatically by uv into the project `.venv` |
| Disk | ~700MB | node_modules ≈400MB (incl. Claude CLI binary) + .venv ≈300MB (markitdown + pymupdf) |

Notes:

- winget usually ships with Windows 10 1709+; if missing, install "App Installer" from the Microsoft Store or use the official installers in the table above.
- **One-click setup: double-click `setup.cmd`** (or run `powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1` in the project directory). The script checks and installs missing Node.js / uv (via winget), creates `.env` (copied from `.env.example`; fill in your keys), then installs all dependencies. **Idempotent and resumable** — if interrupted, just run it again and it picks up where it left off.
- If Node.js and uv are already installed, `npm run setup` is equivalent (it skips the system component detection).
- macOS / Linux: the core service code is platform-neutral, but the setup/start/packaging scripts (PowerShell/cmd) and the Python path detection (`.venv\Scripts\python.exe`) target Windows, so they are **not officially supported**. To force a run: `npm install` yourself, create a venv manually and point `WECHAT_CLAUDE_PYTHON` to `.venv/bin/python`, then start with `npx tsx src/cli.ts`.

**One-click uninstall**: double-click `uninstall.cmd` (or run `npm run uninstall`). By default it only cleans dependencies and build artifacts (node_modules / .venv / dist / .tmp); source code, `.env` keys and WeChat data are untouched — rerunning `setup.cmd` fully restores everything. Optional flags:

| Flag | Effect |
| --- | --- |
| `-RemoveData` | additionally delete `.wechat-claude\` (WeChat token, conversation database, workspaces; irreversible, asks for confirmation) |
| `-RemoveEnv` | additionally delete `.env` (asks for confirmation) |
| `-All` | all of the above + `release\` build artifacts |
| `-Yes` | skip confirmations (for scripted use) |

## Quick Start

```powershell
npm run setup
npm run build:app
npm start
```

`npm run setup` installs all dependencies in one go: Node packages (`npm install`, including the packaging toolchain) plus the Python preprocessing environment (managed by uv: markitdown + pymupdf, ~300MB; automatically skipped with a hint if uv is missing — this does not affect image understanding or plain chat, only PDF/Office/scanned-document parsing becomes unavailable). You can also run plain `npm install` to skip Python. On a brand-new machine without even Node.js, just double-click `setup.cmd` — see "Requirements & One-Click Setup" above.

After startup, the local admin panel URL is printed, by default something like:

```text
Admin panel : http://127.0.0.1:8787/
Data dir    : D:\path\to\project\.wechat-claude
```

If you don't have a WeChat token yet, the service won't exit; open the admin panel, refresh the QR code, scan and confirm to save the token, then restart the service.

## Common Commands

```powershell
npm start
```

Start the production CLI service.

```powershell
npm run build:app
```

Compile the production app and copy database migration files to `dist/`.

```powershell
npm run electron:dev
```

Launch the Electron tray app after building.

```powershell
npm run dist:win
```

Build the Windows single-file portable exe.

```powershell
npm run dist:win:dir
```

Build the unpacked directory version under `release/win-unpacked/`.

```powershell
npm run dist:win:zip
```

Build the directory version and compress it into a zip.

## WeChat Chat Commands

Send these directly in the WeChat chat:

| Command | Effect |
| --- | --- |
| `/new` | Start a new session |
| `/list` | List sessions |
| `/switch <n>` | Switch to the given session |
| `/stop` | Force-stop the AI task currently being processed (sending 停止 / 终止 works too) |
| `/tasks` | List scheduled tasks |
| `/task-del <n or ID>` | Delete a scheduled task |
| `确认` / `取消` | Confirm or cancel a scheduled-task draft |
| `/help` | Show help |

Scheduled tasks are created in natural language: the AI drafts one first, and it only takes effect after you reply 确认 (confirm).

## Environment Variables

Beyond the three `.env` entries (see [.env.example](.env.example)), everything else has a sensible default — override as needed:

| Variable | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | official endpoint | Anthropic-compatible endpoint (e.g. DeepSeek) |
| `ANTHROPIC_API_KEY` | — | API key (x-api-key header) |
| `ANTHROPIC_AUTH_TOKEN` | — | Auth token (Bearer header; either one of the two) |
| `WECHAT_CLAUDE_DATA_DIR` | `.wechat-claude/` next to the app | Data directory |
| `WECHAT_CLAUDE_PYTHON` | auto-detected `.venv` | Python interpreter path (document preprocessing) |
| `WECHAT_CLAUDE_PREPROCESS_SCRIPT` | bundled `scripts/preprocess.py` | Preprocessing script path |
| `WECHAT_CLAUDE_PREPROCESS_MAX_CHARS` | 50000 | Per-file extraction character cap |
| `WECHAT_CLAUDE_PREPROCESS_TIMEOUT_MS` | 60000 | Per-file preprocessing timeout (ms) |
| `WECHAT_CLAUDE_TEXT_DEBOUNCE_MS` | 3000 | Text message merge window (ms) |
| `WECHAT_CLAUDE_MEDIA_DEBOUNCE_MS` | 5000 | Media message merge window (ms) |
| `WECHAT_CLAUDE_MAX_DEBOUNCE_MS` | 15000 | Maximum cumulative merge window (ms) |
| `WECHAT_CLAUDE_VISION_TIMEOUT_MS` | 90000 | Vision request timeout (ms) |
| `WECHAT_CLAUDE_LOG_MAX_MB` | 5 | Per-log-file size cap before rotation (MB) |
| `WECHAT_CLAUDE_RETENTION_DAYS` | 30 | Data retention in days (0 = never clean up) |

## Type Checking

```powershell
npm run build:app
```

The test suite has been removed (the old suite validated historical code copies in `test/features` rather than the real code in `src/`, so it added little value; historical versions can be recovered from git history). After making changes, at least run the compile command above to confirm the types are fine.

## Directory Layout

```text
src/                 production source
src/features/        WeChat connectivity, Claude sessions, bridging, file handling, scheduler, admin backend
src/runtime/         production service runtime
src/electron/        Electron tray entry point
src/types/           supplementary type declarations for production builds
scripts/             build, start and packaging scripts
docs/                usage, architecture, permissions and packaging docs (Chinese)
```

Agent permission rules (which tools are allowed or denied, how writes are confined to the workspace, and the boundaries of the Bash heuristic blocking) are detailed in [Agent Permission Model](docs/permissions.md) (Chinese).

## Local Data & Ignore Rules

The following directories/files are local runtime or build artifacts and are ignored via `.gitignore`:

```text
.wechat-claude/
.tmp/
dist/
release/
node_modules/
.env
.claude/
test_output.json
```

Never commit tokens, SQLite databases, workspaces, logs or build artifacts to git.

## Developer Notes

- Database migrations live in `src/features/01-claude-dialogue/db/migrations/`.
- The admin backend is `src/features/07-frontend-admin/admin.ts`: mode/model/debouncing, preprocessing limits and scan concurrency, API access and standalone vision channel access, message-log management, and the live agent-processing card.
- Image parsing goes through DeepSeek vision (`src/features/03-file-preprocessing/vision.ts`); direct/separate mode and model name live in `.wechat-claude/config.json`, editable in the admin panel with immediate effect; OCR has been removed.
- PDF/Office document parsing uses the optional Python markitdown + pymupdf stack (`scripts/preprocess.py`); scanned PDFs are automatically recognized page by page via vision (up to 20 pages; the AI can continue reading on its own within the workspace); image capabilities do not depend on Python.
- Document-generation reference skills live in `skills/` (minimax-xlsx / pptx-generator / docx); they are copied into the workspace at session creation so the AI can read them directly, bypassing the SDK skills mechanism.
- Bridge preprocessing primitives are exposed as tools (`claude/bridge-tools.ts`, in-process MCP): extract_document / render_pdf_pages / read_scanned_pdf / transcribe_image / extract_pdf_images — the agent calls them on demand; the scanned-PDF continuation prefers the tool; all intermediate files stay inside the session workspace.
- Real-time agent event stream: `claude/events.ts` ring buffer plus the "Agent processing" card in the panel overview (`/api/agent-events` incremental fetching).
- The WeChat send/receive API lives in `src/features/02-wechat-connectivity/wechat/`; parameters and pitfalls are documented in the WeChat iLink Bot API notes (Chinese).
- Claude permissions and workspace confinement live in `src/features/01-claude-dialogue/claude/permissions.ts`; the full rules are in the Agent Permission Model doc (Chinese).
- The Electron portable data-directory fix lives in `src/electron/paths.ts`.
- Logs rotate by size (`WECHAT_CLAUDE_LOG_MAX_MB`); raw messages are recorded per sender in `logs/quote/`; retention is controlled by `WECHAT_CLAUDE_RETENTION_DAYS`.

## License

[MIT](LICENSE)
