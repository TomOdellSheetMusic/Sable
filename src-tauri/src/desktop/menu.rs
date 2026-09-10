#[cfg(desktop)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg(target_os = "macos")]
pub const SETTINGS_MENU_ID: &str = "settings";

pub const TOGGLE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";
pub const DEFAULT_MIC_ACCELERATOR: &str = "CmdOrCtrl+Shift+M";
pub const DEFAULT_DEAFEN_ACCELERATOR: &str = "CmdOrCtrl+Shift+D";

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

/// Emit the call-toggle event for a pressed global shortcut. Kept as a
/// top-level `fn` (rather than inline in the handler closure) so tauri-typegen
/// can statically detect the literal event names and generate the matching
/// `onCallToggleMic` / `onCallToggleDeafen` listeners.
fn emit_call_toggle(
    app: &AppHandle<crate::BrowserEngine>,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) {
    let settings = crate::desktop::tray::current_desktop_settings(app);
    let mic_hotkey = settings
        .mic_hotkey
        .as_deref()
        .unwrap_or(DEFAULT_MIC_ACCELERATOR);
    let deafen_hotkey = settings
        .deafen_hotkey
        .as_deref()
        .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR);

    if Some(*shortcut) == parse_shortcut(mic_hotkey) {
        // Literal event name so tauri-typegen can statically detect it and
        // generate the matching `onCallToggleMic` listener.
        let _ = app.emit("call-toggle-mic", ());
    } else if Some(*shortcut) == parse_shortcut(deafen_hotkey) {
        let _ = app.emit("call-toggle-deafen", ());
    }
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

            emit_call_toggle(app, shortcut);
        })
        .build()
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

/// (Re)registers a call global shortcut, unregistering the previously-active
/// binding first if it changed.
fn apply_call_shortcut(
    gs: &tauri_plugin_global_shortcut::GlobalShortcut<crate::BrowserEngine>,
    prev: &str,
    next: &str,
    name: &str,
) {
    if prev == next {
        return;
    }
    let _ = gs.unregister(prev);
    if let Err(error) = gs.register(next) {
        log::warn!("Failed to register global {name} shortcut: {error}");
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

    let gs = app.global_shortcut();
    apply_call_shortcut(
        gs,
        prev.mic_hotkey
            .as_deref()
            .unwrap_or(DEFAULT_MIC_ACCELERATOR),
        settings
            .mic_hotkey
            .as_deref()
            .unwrap_or(DEFAULT_MIC_ACCELERATOR),
        "mute microphone",
    );
    apply_call_shortcut(
        gs,
        prev.deafen_hotkey
            .as_deref()
            .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR),
        settings
            .deafen_hotkey
            .as_deref()
            .unwrap_or(DEFAULT_DEAFEN_ACCELERATOR),
        "deafen",
    );
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
