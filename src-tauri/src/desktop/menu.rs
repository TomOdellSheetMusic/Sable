#[cfg(desktop)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub const SETTINGS_MENU_ID: &str = "settings";

pub const TOGGLE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";
pub const DEFAULT_MIC_ACCELERATOR: &str = "CmdOrCtrl+Shift+M";
pub const DEFAULT_DEAFEN_ACCELERATOR: &str = "CmdOrCtrl+Shift+D";

/// Emitted to the webview when the global mute-microphone hotkey is pressed.
pub const TOGGLE_MIC_EVENT: &str = "call-toggle-mic";
/// Emitted to the webview when the global deafen (mute everything) hotkey is pressed.
pub const TOGGLE_DEAFEN_EVENT: &str = "call-toggle-deafen";

// Extend the standard menu (Edit submenu for webview copy/paste, Quit, Close)
// with a Settings item.
#[cfg(target_os = "macos")]
pub fn build_app_menu(
    handle: &AppHandle<crate::BrowserEngine>,
) -> tauri::Result<tauri::menu::Menu<crate::BrowserEngine>> {
    use tauri::menu::{Menu, MenuItem, Submenu};

    let menu = Menu::default(handle)?;
    let settings = MenuItem::with_id(
        handle,
        SETTINGS_MENU_ID,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let preferences = Submenu::with_items(handle, "Preferences", true, &[&settings])?;
    menu.append(&preferences)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
pub fn handle_menu_event(app: &AppHandle<crate::BrowserEngine>, event: &tauri::menu::MenuEvent) {
    if event.id().as_ref() == SETTINGS_MENU_ID {
        let _ = app.emit("open-settings", ());
    }
}

pub fn toggle_main_window(app: &AppHandle<crate::BrowserEngine>) {
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        let _ = crate::show_or_create_main_window(app);
    }
}

fn parse_shortcut(binding: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    binding.parse().ok()
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<crate::BrowserEngine> {
    use tauri_plugin_global_shortcut::{Builder, ShortcutState};

    Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }

            // Toggle-window shortcut is fixed.
            if Some(*shortcut) == parse_shortcut(TOGGLE_WINDOW_ACCELERATOR) {
                toggle_main_window(app);
                return;
            }

            let settings = crate::desktop::tray::current_desktop_settings(app);
            let mic_hotkey = settings.mic_hotkey.as_deref().unwrap_or(DEFAULT_MIC_ACCELERATOR);
            let deafen_hotkey = settings
                .deafen_hotkey
                .as_deref()
                .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

            let event_name = if Some(*shortcut) == parse_shortcut(mic_hotkey) {
                TOGGLE_MIC_EVENT
            } else if Some(*shortcut) == parse_shortcut(deafen_hotkey) {
                TOGGLE_DEAFEN_EVENT
            } else {
                return;
            };

            let _ = app.emit(event_name, ());
        })
        .build()
}

pub fn register_global_shortcuts(app: &AppHandle<crate::BrowserEngine>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let settings = crate::desktop::tray::current_desktop_settings(app);
    let mic_hotkey = settings.mic_hotkey.as_deref().unwrap_or(DEFAULT_MIC_ACCELERATOR);
    let deafen_hotkey = settings
        .deafen_hotkey
        .as_deref()
        .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

    for (name, accelerator) in [
        ("show/hide window", TOGGLE_WINDOW_ACCELERATOR),
        ("mute microphone", mic_hotkey),
        ("deafen", deafen_hotkey),
    ] {
        if let Err(error) = app.global_shortcut().register(accelerator) {
            log::warn!("Failed to register global {name} shortcut: {error}");
        }
    }
}

/// (Re)registers the call global shortcuts, unregistering the previously-active
/// ones. `prev` is the previously-stored hotkey settings (before they were
/// overwritten by `settings`).
pub fn apply_call_shortcuts(
    app: &AppHandle<crate::BrowserEngine>,
    prev: &crate::desktop::settings::DesktopSettings,
    settings: &crate::desktop::settings::DesktopSettings,
) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let prev_mic = prev.mic_hotkey.as_deref().unwrap_or(DEFAULT_MIC_ACCELERATOR);
    let prev_deafen = prev.deafen_hotkey.as_deref().unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);
    let next_mic = settings.mic_hotkey.as_deref().unwrap_or(DEFAULT_MIC_ACCELERATOR);
    let next_deafen = settings.deafen_hotkey.as_deref().unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

    let gs = app.global_shortcut();

    if prev_mic != next_mic {
        let _ = gs.unregister(prev_mic);
        if let Err(error) = gs.register(next_mic) {
            log::warn!("Failed to register global mute microphone shortcut: {error}");
        }
    }
    if prev_deafen != next_deafen {
        let _ = gs.unregister(prev_deafen);
        if let Err(error) = gs.register(next_deafen) {
            log::warn!("Failed to register global deafen shortcut: {error}");
        }
    }
}
