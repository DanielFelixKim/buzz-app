//! The saved Builderlab browser sign-in credential of a build whose
//! Builderlab plugin does not use NIP-FI, so that sign-in survives restarts.
//! It is one OS secure item of its own per profile, never another item.
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.builderlab-session.debug"
} else {
    "xyz.block.buzz.desktop.builderlab-session"
};
const LIMIT: usize = 4096;

#[cfg_attr(test, allow(dead_code))]
fn account() -> String {
    std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into())
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied => "Secure storage access was denied",
            Error::Busy => "Another Buzz app is using secure storage",
            _ => "Secure storage is unavailable",
        }
        .into()
    }
    pub(super) fn read() -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match credentials::read(SERVICE, &account()) {
            Ok(value) => Ok(Some(value)),
            Err(Error::Absent) => Ok(None),
            Err(e) => Err(error(e)),
        }
    }
    pub(super) fn replace(value: &[u8]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return security_framework::os::macos::keychain::SecKeychain::default()
            .and_then(|keychain| keychain.set_generic_password(SERVICE, &account(), value))
            .map_err(|_| "Secure storage is unavailable".to_string());
        #[cfg(not(target_os = "macos"))]
        credentials::replace(SERVICE, &account(), value).map_err(error)
    }
    pub(super) fn delete() -> Result<(), String> {
        match credentials::delete(SERVICE, &account()) {
            Ok(()) | Err(Error::Absent) => Ok(()),
            Err(e) => Err(error(e)),
        }
    }
}

// Native tests and other platforms never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
mod platform {
    use super::*;
    const NONE: &str = "Secure storage is not available here";
    pub(super) fn read() -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        Err(NONE.into())
    }
    pub(super) fn replace(_: &[u8]) -> Result<(), String> {
        Err(NONE.into())
    }
    pub(super) fn delete() -> Result<(), String> {
        Err(NONE.into())
    }
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|_| "Secure storage is unavailable".to_string())?
}

/// The saved credential record, or `None` when there is none.
#[tauri::command]
pub(crate) async fn builderlab_session_load() -> Result<Option<String>, String> {
    let value = blocking(platform::read).await?;
    value
        .map(|bytes| {
            String::from_utf8(bytes.to_vec()).map_err(|_| "The saved sign-in is damaged".into())
        })
        .transpose()
}

#[tauri::command]
pub(crate) async fn builderlab_session_save(value: String) -> Result<(), String> {
    let value = Zeroizing::new(value);
    if value.is_empty() || value.len() > LIMIT {
        return Err("Invalid Builderlab sign-in".into());
    }
    blocking(move || platform::replace(value.as_bytes())).await
}

#[tauri::command]
pub(crate) async fn builderlab_session_clear() -> Result<(), String> {
    blocking(platform::delete).await
}
