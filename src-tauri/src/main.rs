// WeChat Claude tray shell (Tauri 2, Windows-first).
//
// Responsibilities:
//   - spawn the bundled Node runtime running the compiled service
//     (node/node.exe dist/src/cli.js), hidden, with cwd = the exe directory
//   - health-poll http://127.0.0.1:<port>/api/status and drive the tray
//     status item + the first-run installer window (bootstrap mode)
//   - tray menu: open panel / data dir / log / restart / quit
// The installer page and the admin panel are both served by the Node
// service itself; this shell only hosts windows and process lifecycle.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

struct ShellState {
    port: u16,
    exe_dir: PathBuf,
    data_dir: PathBuf,
    node: Mutex<Option<Child>>,
    state_item: Mutex<Option<MenuItem<Wry>>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: surface whatever view is active.
            if let Some(win) = app.get_webview_window("installer") {
                let _ = win.show();
                let _ = win.set_focus();
            } else {
                open_panel(app);
            }
        }))
        .on_window_event(|window, event| {
            // Closing the installer window hides it to tray; the Node
            // service (and any in-flight download) keeps running.
            if window.label() == "installer" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // In dev builds resolve paths from the repo root (the debug exe
            // lives in src-tauri/target/debug where no node/ bundle exists);
            // packaged builds use the exe's own directory.
            #[cfg(debug_assertions)]
            let exe_dir = {
                let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
                manifest.parent().expect("repo root").to_path_buf()
            };
            #[cfg(not(debug_assertions))]
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .expect("cannot resolve exe directory");
            let port = std::env::var("WECHAT_ADMIN_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(8787);
            let data_dir = std::env::var("WECHAT_CLAUDE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| exe_dir.join(".wechat-claude"));

            let state_item = MenuItem::with_id(app, "state", "状态：启动中…", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "打开管理面板", true, None::<&str>)?;
            let installer_item = MenuItem::with_id(app, "installer", "组件安装", true, None::<&str>)?;
            let data_item = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let log_item = MenuItem::with_id(app, "log", "打开日志文件", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &state_item,
                    &PredefinedMenuItem::separator(app)?,
                    &open_item,
                    &installer_item,
                    &data_item,
                    &log_item,
                    &PredefinedMenuItem::separator(app)?,
                    &restart_item,
                    &quit_item,
                ],
            )?;

            let icon = tauri::image::Image::from_bytes(TRAY_ICON_PNG)?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("WeChat Claude")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_panel(app),
                    "installer" => ensure_installer_window(app),
                    "data" => open_path(&app.state::<ShellState>().data_dir),
                    "log" => open_path(&log_file(app)),
                    "restart" => restart_service(app),
                    "quit" => {
                        shutdown_node(app, true);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            app.manage(ShellState {
                port,
                exe_dir,
                data_dir,
                node: Mutex::new(None),
                state_item: Mutex::new(Some(state_item)),
            });

            spawn_node(app.handle())?;
            let watcher = app.handle().clone();
            std::thread::spawn(move || watcher_loop(watcher));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // Backstop for exits not routed through the tray menu.
                kill_child(app_handle);
            }
        });
}

// ------------------------------------------------------------------ process

fn spawn_node(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<ShellState>();
    let node_exe = state.exe_dir.join("node").join("node.exe");
    let entry = state.exe_dir.join("dist").join("src").join("cli.js");
    if !entry.is_file() {
        set_label(app, "错误：未找到 dist\\src\\cli.js");
        return Err(format!("missing {}", entry.display()).into());
    }
    // Debug builds fall back to the system Node when no bundle is present.
    let node_command = if node_exe.is_file() {
        node_exe
    } else {
        #[cfg(debug_assertions)]
        {
            PathBuf::from("node")
        }
        #[cfg(not(debug_assertions))]
        {
            set_label(app, "错误：未找到 node\\node.exe");
            return Err(format!("missing {}", node_exe.display()).into());
        }
    };
    let mut cmd = Command::new(&node_command);
    cmd.arg("dist/src/cli.js").current_dir(&state.exe_dir);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    place_in_kill_on_close_job(&mut child);
    *state.node.lock().unwrap() = Some(child);
    set_label(app, "状态：启动中…");
    Ok(())
}

/// Put the child in a Job Object with KILL_ON_JOB_CLOSE so the Node service
/// cannot be orphaned when this shell dies unexpectedly (crash, taskkill).
/// The job handle is intentionally leaked: it lives until our process exits,
/// which is exactly when the children should die.
#[cfg(windows)]
fn place_in_kill_on_close_job(child: &mut Child) {
    #[repr(C)]
    struct IoCounters([u64; 6]);
    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const core::ffi::c_void, name: *const u16) -> *mut core::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut core::ffi::c_void,
            info_class: usize,
            info: *const core::ffi::c_void,
            info_len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(
            job: *mut core::ffi::c_void,
            process: *mut core::ffi::c_void,
        ) -> i32;
        fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut core::ffi::c_void;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: usize = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("job: CreateJobObjectW failed");
            return;
        }
        let mut info: ExtendedLimitInformation = std::mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<ExtendedLimitInformation>() as u32,
        ) == 0 {
            eprintln!("job: SetInformationJobObject failed");
            return;
        }
        // std's Child handle lacks PROCESS_SET_QUOTA, so open our own.
        let process = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            0,
            child.id(),
        );
        if process.is_null() {
            eprintln!("job: OpenProcess({}) failed", child.id());
            return;
        }
        if AssignProcessToJobObject(job, process) == 0 {
            eprintln!("job: AssignProcessToJobObject failed");
        }
        // The raw job handle is never closed, so it lives until this process
        // exits — exactly when the children should die.
    }
}

/// Graceful stop (POST /api/shutdown, wait, then kill). Blocks up to ~10s.
fn shutdown_node(app: &AppHandle, graceful: bool) {
    let state = app.state::<ShellState>();
    if graceful {
        let _ = http_call(state.port, "POST", "/api/shutdown");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let exited = {
            let mut guard = state.node.lock().unwrap();
            match guard.as_mut() {
                None => true,
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        true
                    }
                    Ok(None) => {
                        if Instant::now() > deadline {
                            let _ = child.kill();
                            *guard = None;
                        }
                        false
                    }
                    Err(_) => {
                        let _ = child.kill();
                        *guard = None;
                        true
                    }
                },
            }
        };
        if exited {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn kill_child(app: &AppHandle) {
    let taken = app.state::<ShellState>().node.lock().unwrap().take();
    if let Some(mut child) = taken {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn restart_service(app: &AppHandle) {
    set_label(app, "状态：正在重启…");
    shutdown_node(app, true);
    if let Err(err) = spawn_node(app) {
        eprintln!("restart failed: {err}");
        set_label(app, "状态：重启失败");
    }
}

// ------------------------------------------------------------------ watcher

fn watcher_loop(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(900));

        // Surface an unexpected child exit even when HTTP still answers
        // from a stale server (should not happen, but cheap to check).
        let (port, child_alive) = {
            let state = app.state::<ShellState>();
            let alive = {
                let mut guard = state.node.lock().unwrap();
                match guard.as_mut() {
                    None => false,
                    Some(child) => matches!(child.try_wait(), Ok(None)),
                }
            };
            (state.port, alive)
        };

        match http_call(port, "GET", "/api/status") {
            Ok(status) => {
                let service_state = status["status"]["serviceState"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        if status["status"]["running"].as_bool() == Some(true) {
                            "running".to_string()
                        } else {
                            "starting".to_string()
                        }
                    });
                match service_state.as_str() {
                    "bootstrap" => {
                        set_label(&app, "状态：首次运行安装");
                        ensure_installer_window(&app);
                    }
                    "waiting_for_login" => set_label(&app, "状态：待扫码登录"),
                    "running" => set_label(&app, "状态：运行中"),
                    "starting" => set_label(&app, "状态：启动中…"),
                    "failed" => set_label(&app, "状态：启动失败（见日志）"),
                    "stopping" | "stopped" => set_label(&app, "状态：已停止"),
                    _ => set_label(&app, "状态：未知"),
                }
            }
            Err(_) => {
                if child_alive {
                    set_label(&app, "状态：启动中…");
                } else {
                    set_label(&app, "状态：服务未运行");
                }
            }
        }
    }
}

/// Show the installer window, always at /install. If the window exists but
/// was left on the admin panel (its "打开管理面板" link navigates in-place),
/// navigate it back first so the tray entry always means "组件安装".
/// No auto-opening of the system browser anywhere: entering the panel is
/// the user's explicit click (installer link, tray menu or tray icon).
fn ensure_installer_window(app: &AppHandle) {
    let port = app.state::<ShellState>().port;
    if let Some(win) = app.get_webview_window("installer") {
        let _ = win.eval("if (location.pathname !== '/install') location.replace('/install')");
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = match tauri::Url::parse(&format!("http://127.0.0.1:{port}/install")) {
        Ok(url) => url,
        Err(_) => return,
    };
    let app_in_closure = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(&app_in_closure, "installer", WebviewUrl::External(url))
            .title("WeChat Claude · 组件安装")
            .inner_size(640.0, 760.0)
            .min_inner_size(480.0, 560.0)
            .center()
            .build();
        if let Err(err) = built {
            eprintln!("installer window failed: {err}");
        }
    });
}

fn set_label(app: &AppHandle, text: &str) {
    let item = app
        .state::<ShellState>()
        .state_item
        .lock()
        .unwrap()
        .clone();
    let Some(item) = item else { return };
    let text = text.to_string();
    let _ = app.run_on_main_thread(move || {
        let _ = item.set_text(text);
    });
}

// ------------------------------------------------------------------- openers

fn log_file(app: &AppHandle) -> PathBuf {
    app.state::<ShellState>()
        .data_dir
        .join("logs")
        .join("service.log")
}

fn open_panel(app: &AppHandle) {
    let port = app.state::<ShellState>().port;
    open_externally(&format!("http://127.0.0.1:{}/", port));
}

fn open_path(path: &std::path::Path) {
    open_externally(&path.display().to_string());
}

/// Open a URL / file / folder with the system default handler.
fn open_externally(target: &str) {
    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("xdg-open").arg(target).spawn();
    }
}

// --------------------------------------------------------------------- http

/// Minimal HTTP/1.0 call so the shell avoids pulling in an HTTP stack.
/// HTTP/1.0 also sidesteps chunked responses from the Node server.
fn http_call(port: u16, method: &str, path: &str) -> Result<serde_json::Value, String> {
    let addr = format!("127.0.0.1:{port}");
    let addr = addr
        .parse::<std::net::SocketAddr>()
        .map_err(|e| e.to_string())?;
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_millis(1200)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let body = raw.splitn(2, "\r\n\r\n").nth(1).ok_or("no response body")?;
    serde_json::from_str(body).map_err(|e| e.to_string())
}
