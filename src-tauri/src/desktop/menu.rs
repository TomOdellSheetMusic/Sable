#[cfg(desktop)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub const SETTINGS_MENU_ID: &str = "settings";

/// Default global hotkey that toggles the microphone.
pub const DEFAULT_MIC_ACCELERATOR: &str = "CmdOrCtrl+Shift+M";
/// Default global hotkey that toggles deafen (mute everything).
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

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<crate::BrowserEngine> {
    use tauri_plugin_global_shortcut::{Builder, ShortcutState};

    Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }

            // The toggle-window shortcut is handled by the configurable
            // `apply_toggle_window_shortcut` registration. Any other registered
            // shortcut is a call hotkey (mic/deafen), so match it against the
            // current settings and emit the corresponding event.
            let settings = crate::desktop::tray::current_desktop_settings(app);
            let mic_hotkey = settings
                .mic_hotkey
                .as_deref()
                .unwrap_or(DEFAULT_MIC_ACCELERATOR);
            let deafen_hotkey = settings
                .deafen_hotkey
                .as_deref()
                .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

            let event_name = if Some(*shortcut) == parse_shortcut(mic_hotkey) {
                TOGGLE_MIC_EVENT
            } else if Some(*shortcut) == parse_shortcut(deafen_hotkey) {
                TOGGLE_DEAFEN_EVENT
            } else {
                // Fall back to the toggle-window behavior for any other shortcut.
                toggle_main_window(app);
                return;
            };

            let _ = app.emit(event_name, ());
        })
        .build()
}

fn parse_shortcut(binding: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    binding.parse().ok()
}

/// Convert a web hotkey binding (`"mod+shift+s"`) into a Tauri accelerator
/// string and validate it parses as a real `Shortcut`. The accelerator parser
/// is case-insensitive and accepts the web token names natively (`arrowdown`,
/// `home`, `f5`, …), so only the `mod` and `meta` aliases need rewriting.
fn web_to_tauri_accelerator(web: &str) -> Result<String, String> {
    use tauri_plugin_global_shortcut::Shortcut;

    let tauri_str = web
        .split('+')
        .map(|part| match part.to_lowercase().as_str() {
            "mod" => "CmdOrCtrl".to_string(),
            "meta" => "Super".to_string(),
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+");

    tauri_str
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut '{tauri_str}': {error}"))
        .map(|_| tauri_str)
}

/// Error returned when a global shortcut is requested on a Wayland session.
/// Wayland compositors never route key presses through the X server unless an
/// X11 window is focused, so an XWayland grab "registers" but cannot fire
/// reliably. `global-hotkey` has no Wayland backend; X11 sessions work.
#[cfg(target_os = "linux")]
const WAYLAND_UNSUPPORTED: &str =
    "Global shortcuts are not supported on Wayland sessions; they require an X11 session on Linux.";

#[cfg(target_os = "linux")]
fn linux_global_shortcut_error() -> Option<String> {
    std::env::var_os("WAYLAND_DISPLAY")
        .is_some()
        .then(|| WAYLAND_UNSUPPORTED.to_string())
}

/// Apply the current toggle-window global shortcut. Unregisters any previously
/// registered shortcut, then registers the new one when `binding` is `Some`.
/// `binding` is in web hotkey format.
pub fn apply_toggle_window_shortcut(
    app: &AppHandle<crate::BrowserEngine>,
    binding: Option<&str>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    #[cfg(target_os = "linux")]
    if let Some(error) = linux_global_shortcut_error() {
        return Err(error);
    }

    // The app only ever registers a single global shortcut, so unregistering
    // everything is precise and avoids tracking the live accelerator.
    let _ = app.global_shortcut().unregister_all();

    if let Some(web) = binding {
        let accelerator = web_to_tauri_accelerator(web)?;
        app.global_shortcut()
            .register(accelerator.as_str())
            .map_err(|error| format!("Failed to register shortcut '{accelerator}': {error}"))?;
    }
    Ok(())
}

/// Register the global call hotkeys (mic/deafen) alongside the configurable
/// toggle-window shortcut. `settings` provides the current mic/deafen bindings
/// in web hotkey format; `None` means the default accelerator is used.
pub fn register_call_shortcuts(
    app: &AppHandle<crate::BrowserEngine>,
    settings: &crate::desktop::settings::DesktopSettings,
) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let mic_hotkey = settings
        .mic_hotkey
        .as_deref()
        .unwrap_or(DEFAULT_MIC_ACCELERATOR);
    let deafen_hotkey = settings
        .deafen_hotkey
        .as_deref()
        .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

    for (name, accelerator) in [("mute microphone", mic_hotkey), ("deafen", deafen_hotkey)] {
        if let Err(error) = app.global_shortcut().register(accelerator) {
            log::warn!("Failed to register global {name} shortcut: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_mod_and_meta_tokens() {
        assert_eq!(
            web_to_tauri_accelerator("mod+shift+s").unwrap(),
            "CmdOrCtrl+shift+s"
        );
        assert_eq!(web_to_tauri_accelerator("meta+j").unwrap(), "Super+j");
    }

    #[test]
    fn passes_web_tokens_through_to_the_parser() {
        assert!(web_to_tauri_accelerator("control+e").is_ok());
        assert!(web_to_tauri_accelerator("alt+shift+arrowdown").is_ok());
        assert!(web_to_tauri_accelerator("mod+home").is_ok());
        assert!(web_to_tauri_accelerator("mod+shift+f5").is_ok());
    }

    #[test]
    fn rejects_invalid_bindings() {
        assert!(web_to_tauri_accelerator("").is_err());
        assert!(web_to_tauri_accelerator("mod").is_err());
        assert!(web_to_tauri_accelerator("mod+notakey").is_err());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn rejects_global_shortcuts_only_on_wayland_sessions() {
        let original = std::env::var_os("WAYLAND_DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");
        assert!(linux_global_shortcut_error().is_none());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        assert_eq!(
            linux_global_shortcut_error(),
            Some(WAYLAND_UNSUPPORTED.to_string())
        );
        match original {
            Some(value) => std::env::set_var("WAYLAND_DISPLAY", value),
            None => std::env::remove_var("WAYLAND_DISPLAY"),
        }
    }
}
