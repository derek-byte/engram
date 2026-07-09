use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::AppState;

const HOTKEY: &str = "CmdOrCtrl+Shift+E";

// Injected before page load. Esc composition — division of labor with the page's
// own keydown handler (src/ui/index.html):
//   • The PAGE owns closing modal surfaces: it closes the trajectory/wiki overlay,
//     and resets the settings view (or any non-search view) back to search, via its
//     own document 'keydown' listener (bubble phase).
//   • THIS SCRIPT only hides the window, and only when no modal surface is up, so we
//     never double-act. We listen in the CAPTURE phase and read
//     window.__engramModalOpen() BEFORE the page's bubble handler mutates state:
//       - modal open (settings pane or overlay) → do nothing; the page closes it.
//       - otherwise (plain search / wiki index)  → hide the window (spotlight dismiss).
// (In the wiki index the page also resets to search; harmless — next summon lands on
// search.) A try/catch falls back to probing #overlay if __engramModalOpen is absent.
const ESC_SCRIPT: &str = r#"
window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var modalOpen;
  try {
    modalOpen = typeof window.__engramModalOpen === 'function' && window.__engramModalOpen();
  } catch (_) {
    var ov = document.getElementById('overlay');
    modalOpen = !!(ov && ov.classList.contains('open'));
  }
  if (modalOpen) return; // the page's own handler closes the surface
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('hide_main_window');
  }
}, true);
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

/// Return the existing "main" window, or lazily create it against the supervised
/// UI server. `None` if the server isn't ready yet or window creation failed.
fn ensure_main_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = app.get_webview_window("main") {
        return Some(win);
    }

    let url = {
        let st = app.state::<AppState>();
        let g = st.ui.lock().unwrap();
        match g.as_ref() {
            Some(s) => s.url(),
            None => return None, // server not ready yet
        }
    };

    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[engram-app] bad ui url {url}: {e}");
            return None;
        }
    };

    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("engram")
        .inner_size(760.0, 560.0)
        .initialization_script(ESC_SCRIPT);
    // macOS: transparent title bar so the web UI paints edge-to-edge. The page
    // renders a full-width 48px titlebar strip under `.tauri` (src/ui/app.css);
    // the traffic lights are inset to sit vertically centered in it.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 18.0));

    match builder.build() {
        Ok(win) => {
            let w = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });
            Some(win)
        }
        Err(e) => {
            eprintln!("[engram-app] failed to create search window: {e}");
            None
        }
    }
}

/// Spotlight-style summon/hide of the search window. Created lazily on first use
/// against the supervised UI server; afterwards show+focus / hide.
pub fn toggle_search_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
    }
    if let Some(win) = ensure_main_window(app) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.eval("document.getElementById('q')?.focus()");
    }
}

/// Dock-icon click / macOS reopen: always show + focus, never hide (unlike the
/// hotkey toggle — clicking the Dock while visible should not dismiss).
pub fn show_search_window(app: &AppHandle) {
    if let Some(win) = ensure_main_window(app) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.eval("document.getElementById('q')?.focus()");
    }
}

/// Tray "Settings…": show/focus the search window and open the settings pane.
/// Polls briefly for `window.openSettings` in case the page hasn't finished
/// loading yet (fresh window: the init script runs before the page's own script).
pub fn open_settings(app: &AppHandle) {
    if let Some(win) = ensure_main_window(app) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.eval(
            "(function o(n){if(window.openSettings){window.openSettings();}\
             else if(n>0){setTimeout(function(){o(n-1);},100);}})(20);",
        );
    }
}
