mod hotkey;
mod paths;
mod server;
mod synthesis;
mod tray;
mod update;

#[cfg(test)]
mod testkit;

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::paths::Paths;
use crate::server::UiServer;

pub(crate) const TRAY_ID: &str = "engram-tray";

/// Shared app state: the resolved paths, the supervised children, the dynamic
/// tray handles, and the two tray icon variants.
pub(crate) struct AppState {
    pub paths: Paths,
    pub ui: Mutex<Option<UiServer>>,
    pub synth_child: Mutex<Option<Child>>,
    pub ui_item: MenuItem<Wry>,
    pub synth_item: MenuItem<Wry>,
    pub run_now_item: MenuItem<Wry>,
    pub idle_icon: Image<'static>,
    pub active_icon: Image<'static>,
    pub last_active: AtomicBool,
    /// A launch-time pull touched app/src-tauri — the installed shell is stale
    /// and the frontend shows the rebuild banner.
    pub shell_update_pending: AtomicBool,
}

/// App command: hide the search window. Invoked from the injected Esc handler on
/// the loopback UI origin (granted by capabilities/remote-ui.json).
#[tauri::command]
fn hide_main_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/// App command: did the launch-time auto-pull leave the installed shell stale?
/// The frontend polls this once on load to decide whether to show the banner.
#[tauri::command]
fn shell_update_status(app: AppHandle) -> bool {
    app.state::<AppState>().shell_update_pending.load(Ordering::Relaxed)
}

/// App command: rebuild + swap + relaunch the shell via `make app`, detached —
/// the make target quits this instance once the build succeeds.
#[tauri::command]
fn rebuild_shell(app: AppHandle) -> Result<(), String> {
    update::spawn_rebuild(&app.state::<AppState>().paths)
}

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (Spotlight picking the
        // repo's build artifact, or open during a make-app swap) hands off to
        // the running instance — summoning its window — instead of starting a
        // duplicate that fights over the tray, hotkey, and ui-server children.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            hotkey::show_search_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        hotkey::toggle_search_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![hide_main_window, shell_update_status, rebuild_shell])
        .setup(|app| {
            // Pure menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let paths = Paths::resolve();

            let open_search =
                MenuItem::with_id(app, "open_search", "Open Search", true, None::<&str>)?;
            let open_settings =
                MenuItem::with_id(app, "open_settings", "Settings…", true, None::<&str>)?;
            let run_now =
                MenuItem::with_id(app, "run_synth", "Run Synthesis Now", true, None::<&str>)?;
            let ui_item = MenuItem::with_id(app, "ui_status", "UI: starting…", false, None::<&str>)?;
            let synth_item =
                MenuItem::with_id(app, "synth_status", "Synthesis: idle", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = MenuBuilder::new(app)
                .item(&open_search)
                .item(&open_settings)
                .item(&run_now)
                .separator()
                .item(&ui_item)
                .item(&synth_item)
                .separator()
                .item(&quit)
                .build()?;

            let idle_icon = tauri::include_image!("icons/tray-idle.png");
            let active_icon = tauri::include_image!("icons/tray-active.png");

            app.manage(AppState {
                paths: paths.clone(),
                ui: Mutex::new(None),
                synth_child: Mutex::new(None),
                ui_item: ui_item.clone(),
                synth_item: synth_item.clone(),
                run_now_item: run_now.clone(),
                idle_icon: idle_icon.clone(),
                active_icon: active_icon.clone(),
                last_active: AtomicBool::new(false),
                shell_update_pending: AtomicBool::new(false),
            });

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(idle_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("engram")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open_search" => hotkey::toggle_search_window(app),
                    "open_settings" => hotkey::open_settings(app),
                    "run_synth" => run_synthesis_now(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            match paths.validate() {
                Ok(()) => start_ui_async(app.handle().clone()),
                Err(e) => {
                    let _ = ui_item.set_text(format!("UI: error ({e})"));
                    error_dialog(
                        app.handle(),
                        &format!("engram can't start the UI server.\n\n{e}\n\nQuit from the tray menu."),
                    );
                }
            }

            hotkey::register(app.handle(), &open_search);
            spawn_poller(app.handle().clone());
            spawn_sigterm_handler(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the engram app")
        .run(|handle, event| match event {
            // Dock-icon click on an Accessory app arrives as Reopen with no
            // visible windows — summon the search window like the hotkey would.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => hotkey::show_search_window(handle),
            RunEvent::Exit => {
                // Kill the supervised ui child (no orphan on its loopback port).
                // An in-flight synthesis-run child is deliberately NOT killed — it
                // self-releases the shared lock; SIGKILL would strand a stale lock.
                let st = handle.state::<AppState>();
                if let Some(mut srv) = st.ui.lock().unwrap().take() {
                    srv.kill();
                }
                let _ = handle.global_shortcut().unregister_all();
            }
            _ => {}
        });
}

/// Start the ui server off the main thread (startup can take up to 20s), then
/// store the handle and update the status line — or surface an error. The
/// guarded auto-pull runs first, so the spawned server executes the freshest
/// merged code (the server reads the repo per-request; only Rust needs more).
fn start_ui_async(handle: AppHandle) {
    std::thread::spawn(move || {
        let paths = handle.state::<AppState>().paths.clone();
        let outcome = update::auto_pull(&paths.repo_root);
        update::log_outcome(&paths, &outcome);
        if outcome.shell_changed {
            handle
                .state::<AppState>()
                .shell_update_pending
                .store(true, Ordering::Relaxed);
        }
        match server::start(&paths) {
            Ok(srv) => {
                let text = format!("UI: {}", srv.url());
                *handle.state::<AppState>().ui.lock().unwrap() = Some(srv);
                let item = handle.state::<AppState>().ui_item.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = item.set_text(text);
                });
            }
            Err(e) => {
                let item = handle.state::<AppState>().ui_item.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = item.set_text("UI: error");
                });
                error_dialog(&handle, &format!("engram UI server failed to start.\n\n{e}"));
            }
        }
    });
}

/// Spawn `synthesis-run`. UX-guarded (single-flight + lock-fresh check); the
/// CLI's own advisory lock is the correctness boundary.
fn run_synthesis_now(app: &AppHandle) {
    let st = app.state::<AppState>();
    if synth_child_running(&st) {
        return; // our previous run still going
    }
    if synthesis::synthesis_active(&st.paths.synthesis_lock(), SystemTime::now()) {
        return; // some run (nightly or prior) holds the lock
    }
    match synthesis::spawn_synthesis_run(&st.paths) {
        Ok(child) => {
            *st.synth_child.lock().unwrap() = Some(child);
            st.last_active.store(true, Ordering::Relaxed);
            tray::update_indicator(app, true);
        }
        Err(e) => error_dialog(app, &format!("Couldn't start synthesis-run.\n\n{e}")),
    }
}

/// True iff the app's own `Run Synthesis Now` child is still running; reaps a
/// finished child as a side effect.
fn synth_child_running(st: &AppState) -> bool {
    let mut g = st.synth_child.lock().unwrap();
    match g.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *g = None;
                false
            }
        },
        None => false,
    }
}

/// 5s poller: active = lock freshness OR our own synthesis child still running
/// (covers a child that dies before taking the lock — the indicator must reset).
/// Pushes tray updates on change; first iteration runs immediately so a lock
/// present at launch is reflected.
fn spawn_poller(handle: AppHandle) {
    std::thread::spawn(move || loop {
        let (active, prev) = {
            let st = handle.state::<AppState>();
            let a = synthesis::synthesis_active(&st.paths.synthesis_lock(), SystemTime::now())
                || synth_child_running(&st);
            let p = st.last_active.swap(a, Ordering::Relaxed);
            (a, p)
        };
        if active != prev {
            tray::update_indicator(&handle, active);
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

/// SIGTERM (kill / logout / shutdown) → the same clean exit path as tray Quit,
/// so the supervised ui child is killed instead of orphaned on its port.
fn spawn_sigterm_handler(handle: AppHandle) {
    let term = std::sync::Arc::new(AtomicBool::new(false));
    if signal_hook::flag::register(signal_hook::consts::SIGTERM, term.clone()).is_err() {
        return; // no handler — SIGTERM falls back to default (documented orphan case)
    }
    std::thread::spawn(move || loop {
        if term.load(Ordering::Relaxed) {
            handle.exit(0);
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    });
}

fn error_dialog(app: &AppHandle, msg: &str) {
    app.dialog()
        .message(msg)
        .kind(MessageDialogKind::Error)
        .title("engram")
        .show(|_| {});
}
