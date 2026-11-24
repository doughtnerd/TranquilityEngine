//! `tauri-plugin-myco-multicast`: an Android `WifiManager.MulticastLock`, held from when the plugin loads until the
//! activity is destroyed, so mDNS discovery (`native/debug-discovery`) receives multicast on a phone. Android drops
//! multicast packets for apps that hold no lock. The Kotlin side is `android/`; desktop and iOS have nothing to do.
//!
//! ```ignore
//! tauri::Builder::default().plugin(tauri_plugin_myco_multicast::init())
//! ```
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.myco.multicast";

/// The plugin. It has no commands: loading it takes the lock on Android, and does nothing elsewhere.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    #[allow(unused_mut)]
    let mut builder = Builder::new("myco-multicast");
    #[cfg(target_os = "android")]
    {
        builder = builder.setup(|_app, api| {
            api.register_android_plugin(PLUGIN_IDENTIFIER, "MulticastPlugin")?;
            Ok(())
        });
    }
    builder.build()
}
