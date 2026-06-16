import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { WechatClaudeService } from "../runtime/service.js";
import { resolveAppRoot } from "./paths.js";

let tray: Tray | null = null;
let service: WechatClaudeService | null = null;
let statusWindow: BrowserWindow | null = null;
let isQuitting = false;

app.setName("WeChat Claude");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void openAdminPanel();
  });

  app.whenReady().then(async () => {
    service = new WechatClaudeService({
      repoRoot: resolveAppRoot({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        cwd: process.cwd(),
        portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      }),
    });
    createTray();
    await service.start();
    updateTrayMenu();
    notifyReady();
  }).catch((err) => {
    showError("启动失败", err);
  });
}

app.on("window-all-closed", () => {
  // Keep the tray app alive when the status window is closed.
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  void quitApp();
});

function createTray(): void {
  const icon = nativeImage.createFromDataURL(createTrayIconDataUrl());
  tray = new Tray(icon);
  tray.setToolTip("WeChat Claude");
  tray.on("click", () => {
    void openAdminPanel();
  });
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const status = service?.getStatus();
  const state = status?.state ?? "starting";
  const adminUrl = status?.adminUrl;
  const paths = status?.paths;

  const menu = Menu.buildFromTemplate([
    {
      label: `状态：${state}`,
      enabled: false,
    },
    {
      label: "打开管理面板",
      enabled: Boolean(adminUrl),
      click: () => void openAdminPanel(),
    },
    {
      label: "显示状态窗口",
      click: () => showStatusWindow(),
    },
    { type: "separator" },
    {
      label: "打开数据目录",
      enabled: Boolean(paths?.dataDir),
      click: () => void shell.openPath(paths?.dataDir ?? ""),
    },
    {
      label: "打开日志文件",
      enabled: Boolean(status?.logFile),
      click: () => void shell.openPath(status?.logFile ?? ""),
    },
    { type: "separator" },
    {
      label: "重启服务",
      click: () => void restartService(),
    },
    {
      label: "退出",
      click: () => void quitApp(),
    },
  ]);

  tray.setContextMenu(menu);
}

async function openAdminPanel(): Promise<void> {
  const adminUrl = service?.getStatus().adminUrl;
  if (!adminUrl) return;
  await shell.openExternal(adminUrl);
}

function showStatusWindow(): void {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 520,
    height: 420,
    title: "WeChat Claude 状态",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  statusWindow.on("closed", () => {
    statusWindow = null;
  });

  const status = service?.getStatus();
  const html = renderStatusHtml(status);
  void statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function restartService(): Promise<void> {
  if (!service) return;
  updateTrayMenu();
  await service.stop();
  service = new WechatClaudeService({
    repoRoot: resolveAppRoot({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      cwd: process.cwd(),
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    }),
  });
  await service.start();
  updateTrayMenu();
  showStatusWindow();
}

async function quitApp(): Promise<void> {
  isQuitting = true;
  try {
    await service?.stop();
  } finally {
    app.quit();
  }
}

function notifyReady(): void {
  updateTrayMenu();
  if (process.platform === "win32" && tray) {
    tray.displayBalloon({
      title: "WeChat Claude 已启动",
      content: service?.getStatus().adminUrl ?? "管理面板已准备就绪",
    });
  }
}

function showError(title: string, err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`${title}: ${message}`);
  if (tray) {
    tray.displayBalloon({ title, content: message.slice(0, 240) });
  }
}

function renderStatusHtml(status: ReturnType<WechatClaudeService["getStatus"]> | undefined): string {
  if (!status) {
    return "<!doctype html><meta charset=\"utf-8\"><body><h1>服务未启动</h1></body>";
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>WeChat Claude 状态</title>
  <style>
    body { margin: 0; padding: 28px; font-family: "Segoe UI", sans-serif; color: #18221d; background: #f7f1e3; }
    h1 { margin: 0 0 18px; font-family: Georgia, serif; font-size: 34px; }
    dl { display: grid; grid-template-columns: 110px 1fr; gap: 10px 14px; }
    dt { color: #657369; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { background: rgba(47,107,79,.1); padding: 2px 6px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>WeChat Claude</h1>
  <dl>
    <dt>状态</dt><dd><code>${escapeHtml(status.state)}</code></dd>
    <dt>Admin</dt><dd><code>${escapeHtml(status.adminUrl ?? "")}</code></dd>
    <dt>Token</dt><dd>${status.tokenPresent ? "已存在" : "未配置"}</dd>
    <dt>数据目录</dt><dd><code>${escapeHtml(status.paths.dataDir)}</code></dd>
    <dt>日志</dt><dd><code>${escapeHtml(status.logFile)}</code></dd>
  </dl>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch] ?? ch));
}

function createTrayIconDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="18" fill="#2f6b4f"/>
    <path d="M17 20h30a7 7 0 0 1 7 7v8a7 7 0 0 1-7 7H34l-9 7v-7h-8a7 7 0 0 1-7-7v-8a7 7 0 0 1 7-7Z" fill="#fff8e8"/>
    <circle cx="25" cy="31" r="3" fill="#2f6b4f"/>
    <circle cx="39" cy="31" r="3" fill="#2f6b4f"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
