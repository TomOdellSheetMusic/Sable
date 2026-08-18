#[cfg(desktop)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub const SETTINGS_MENU_ID: &str = "settings";

pub const TOGGLE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";
pub const TOGGLE_MIC_ACCELERATOR: &str = "CmdOrCtrl+Shift+M";
pub const TOGGLE_DEAFEN_ACCELERATOR: &str = "CmdOrCtrl+Shift+D";

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

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<crate::BrowserEngine> {
    use tauri_plugin_global_shortcut::{Builder, Code, Modifiers, Shortcut, ShortcutState};

    // Cmd/Ctrl is the platform-appropriate modifier for these shortcuts.
    #[cfg(target_os = "macos")]
    let primary_modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let primary_modifier = Modifiers::CONTROL;

    Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }

            let event_name = match *shortcut {
                Shortcut {
                    mods: m,
                    key: Code::KeyM,
                    ..
                } if m.contains(primary_modifier) && m.contains(Modifiers::SHIFT) => {
                    TOGGLE_MIC_EVENT
                }
                Shortcut {
                    mods: m,
                    key: Code::KeyD,
                    ..
                } if m.contains(primary_modifier) && m.contains(Modifiers::SHIFT) => {
                    TOGGLE_DEAFEN_EVENT
                }
                _ => {
                    // Existing behavior: CmdOrCtrl+Shift+S shows/hides the window.
                    toggle_main_window(app);
                    return;
                }
            };

            let _ = app.emit(event_name, ());
        })
        .build()
}

pub fn register_global_shortcuts(app: &AppHandle<crate::BrowserEngine>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    for (name, accelerator) in [
        ("show/hide window", TOGGLE_WINDOW_ACCELERATOR),
        ("mute microphone", TOGGLE_MIC_ACCELERATOR),
        ("deafen", TOGGLE_DEAFEN_ACCELERATOR),
    ] {
        if let Err(error) = app.global_shortcut().register(accelerator) {
            log::warn!("Failed to register global {name} shortcut: {error}");
        }
    }
}
