// Prevents an extra console window on Windows in release. No-op on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    engram_app_lib::run()
}
