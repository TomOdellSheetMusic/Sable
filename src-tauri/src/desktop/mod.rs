pub mod diagnostics;
pub mod download;
pub mod logging;
pub mod menu;
pub mod runtime_state;
pub mod settings;
pub mod tray;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod tray_badge;

#[cfg(windows)]
pub mod windows;
