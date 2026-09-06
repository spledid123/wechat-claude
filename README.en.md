# WeChat Claude

English | [简体中文](README.md)

WeChat Claude is a locally-run WeChat ↔ Claude bridge. It hands WeChat messages over to a Claude Agent for processing, then sends replies, generated files, or scheduled-task results back to WeChat. The production version runs as an Electron tray app and ships with a local admin panel.

This README is aimed at users and visitors. End users of the packaged exe should read the [user guide](docs/user-exe-guide.md); for development and maintenance see the [Developer Guide](docs/developer-guide.md); architecture details are in [Architecture & Packaging](docs/architecture.md), and WeChat API details in [WeChat iLink Bot API Notes](docs/wechat-ilink-api.md). (Docs in `docs/` are currently Chinese only.)

> Most of the code in this project was written with AI assistance — primarily **GLM-5.3**, with some early commits by Claude (see Contributors).

## Features

- **Two-way WeChat ↔ Claude Agent bridge**: QR-code login with a locally persisted token; handles text, voice (auto-transcribed), images, files and quoted messages.
- **A full agent, not just a chat model**: built on the Claude Agent SDK, with tool calling and per-session workspaces.
- **Multi-user sessions**: isolated context and workspace per WeChat sender.
- **Message merge window**: consecutive messages are automatically merged into a single AI request, so splitting one thought across several messages won't make the AI answer the first fragment early — messages arriving within 3 s of each other (text) or 5 s (images/files and other media) join the same batch, and if messages keep streaming in, the cumulative wait is capped at 15 s before processing is forced. All three windows are adjustable in the admin panel's settings page or via environment variables.
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

## License

[MIT](LICENSE)
