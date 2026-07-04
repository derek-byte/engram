use tauri::{AppHandle, Manager};

use crate::{AppState, TRAY_ID};

/// Reflect synthesis activity on the tray: swap the icon variant, retitle the
/// status line, and enable/disable `Run Synthesis Now`. Marshalled to the main
/// thread — menu/tray mutation must not happen off it on macOS.
pub fn update_indicator(app: &AppHandle, active: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let st = handle.state::<AppState>();
        if active {
            let _ = st.synth_item.set_text("Synthesis: running…");
            let _ = st.run_now_item.set_enabled(false);
        } else {
            let _ = st.synth_item.set_text("Synthesis: idle");
            let _ = st.run_now_item.set_enabled(true);
        }
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            let icon = if active {
                st.active_icon.clone()
            } else {
                st.idle_icon.clone()
            };
            let _ = tray.set_icon(Some(icon));
            let _ = tray.set_icon_as_template(true);
        }
    });
}
