use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::AppState;

const HOTKEY: &str = "CmdOrCtrl+Shift+E";

// Injected before page load. Esc hides the window UNLESS the trajectory overlay
// is open (then the UI's own Esc handler closes the overlay — both compose).
const ESC_SCRIPT: &str = r#"
window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var ov = document.getElementById('overlay');
  if (ov && ov.classList.contains('open')) return;
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('hide_main_window');
  }
});
"#;

/// Register the global hotkey. Failure (e.g. another app owns Cmd+Shift+E) is
/// non-fatal — the tray "Open Search" path still works; we just note it.
pub fn register(app: &AppHandle, open_search: &MenuItem<Wry>) {
    match app.global_shortcut().register(HOTKEY) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("[engram-app] global hotkey {HOTKEY} registration failed: {e}");
            let _ = open_search.set_text("Open Search  (⌘⇧E unavailable)");
        }
    }
}

/// Spotlight-style summon/hide of the search window. Created lazily on first use
/// against the supervised UI server; afterwards show+focus / hide.
pub fn toggle_search_window(app: &AppHandle) {
    let url = {
        let st = app.state::<AppState>();
        let g = st.ui.lock().unwrap();
        match g.as_ref() {
            Some(s) => s.url(),
            None => return, // server not ready yet
        }
    };

    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.eval("document.getElementById('q')?.focus()");
        }
        return;
    }

    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[engram-app] bad ui url {url}: {e}");
            return;
        }
    };
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("engram")
        .inner_size(760.0, 560.0)
        .initialization_script(ESC_SCRIPT)
        .build()
    {
        Ok(win) => {
            let w = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });
            let _ = win.set_focus();
            let _ = win.eval("document.getElementById('q')?.focus()");
        }
        Err(e) => eprintln!("[engram-app] failed to create search window: {e}"),
    }
}
