// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Assistant credential storage: OS keyring first, legacy plaintext migrate-on-read.
//!
//! Packaged Study prefers the platform credential store (Windows Credential
//! Manager, macOS Keychain, Linux kernel keyutils). Older builds wrote
//! `assistant_secrets.json` under the app config dir (mode `0600` on Unix).
//! On a successful keyring write we remove the migrated entry from that file.
//! When the OS store is unavailable, reads still honor the legacy file and
//! writes fall back to it so the prototype keeps working; a distributed
//! product should proxy keys instead.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Keyring service / application name (account = normalized logical service).
pub const KEYRING_SERVICE: &str = "holdem-study";

/// Legacy filename under the app config dir (pre-keyring prototype).
pub const LEGACY_SECRETS_FILE: &str = "assistant_secrets.json";

#[derive(Default, Serialize, Deserialize)]
struct LegacySecretsFile {
    secrets: HashMap<String, String>,
}

/// Platform (or test) vault used as the primary secret backend.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// Delete is idempotent: missing entries are success.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// OS credential manager via the `keyring` crate.
pub struct OsKeyringVault;

impl Vault for OsKeyringVault {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|err| format!("keyring entry: {err}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(format!("keyring get: {err}")),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|err| format!("keyring entry: {err}"))?;
        entry
            .set_password(value)
            .map_err(|err| format!("keyring set: {err}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|err| format!("keyring entry: {err}"))?;
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("keyring delete: {err}")),
        }
    }
}

/// In-memory vault for unit tests (no OS credential daemon required).
#[derive(Default)]
pub struct MemoryVault {
    inner: Mutex<HashMap<String, String>>,
}

impl Vault for MemoryVault {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "memory vault lock poisoned".to_string())?;
        Ok(guard.get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "memory vault lock poisoned".to_string())?;
        guard.insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "memory vault lock poisoned".to_string())?;
        guard.remove(account);
        Ok(())
    }
}

/// Vault that always fails writes (simulates missing Secret Service).
#[cfg(test)]
struct FailingVault;

#[cfg(test)]
impl Vault for FailingVault {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Err("vault unavailable".into())
    }

    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("vault unavailable".into())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Err("vault unavailable".into())
    }
}

pub struct AssistantSecretStore {
    config_dir: PathBuf,
    vault: Box<dyn Vault>,
}

impl AssistantSecretStore {
    pub fn with_os_keyring(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            vault: Box::new(OsKeyringVault),
        }
    }

    pub fn with_vault(config_dir: PathBuf, vault: Box<dyn Vault>) -> Self {
        Self { config_dir, vault }
    }

    fn legacy_path(&self) -> PathBuf {
        self.config_dir.join(LEGACY_SECRETS_FILE)
    }

    pub fn get(&self, service: &str) -> Result<Option<String>, String> {
        let key = normalize_secret_service(service)?;
        match self.vault.get(&key) {
            Ok(Some(value)) => {
                // Best-effort: drop any leftover plaintext copy after keyring hit.
                let _ = self.remove_legacy_entry(&key);
                return Ok(Some(value));
            }
            Ok(None) => {}
            // Keyring may be missing on headless hosts; fall through to legacy.
            Err(_) => {}
        }

        let Some(legacy) = self.take_legacy_value(&key)? else {
            return Ok(None);
        };

        // Migrate into the OS store when possible; keep file value if migrate fails.
        match self.vault.set(&key, &legacy) {
            Ok(()) => {
                let _ = self.remove_legacy_entry(&key);
                Ok(Some(legacy))
            }
            Err(_) => Ok(Some(legacy)),
        }
    }

    pub fn set(&self, service: &str, value: &str) -> Result<(), String> {
        let key = normalize_secret_service(service)?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err("secret value must be non-empty".into());
        }
        if trimmed.len() > 8192 {
            return Err("secret value too long".into());
        }

        match self.vault.set(&key, trimmed) {
            Ok(()) => {
                let _ = self.remove_legacy_entry(&key);
                Ok(())
            }
            Err(vault_err) => {
                // Degraded path: persist under the legacy 0600 file when OS store
                // is unavailable so local prototypes still work.
                self.write_legacy_entry(&key, trimmed)
                    .map_err(|file_err| {
                        format!(
                            "OS credential store unavailable ({vault_err}); \
                             legacy file fallback failed: {file_err}"
                        )
                    })?;
                Ok(())
            }
        }
    }

    pub fn clear(&self, service: &str) -> Result<(), String> {
        let key = normalize_secret_service(service)?;
        // Clear both backends; vault delete errors are soft when NoEntry-like.
        match self.vault.delete(&key) {
            Ok(()) => {}
            Err(_) => {
                // Still clear the legacy file below.
            }
        }
        self.remove_legacy_entry(&key)?;
        Ok(())
    }

    pub fn has(&self, service: &str) -> Result<bool, String> {
        Ok(self.get(service)?.is_some())
    }

    fn read_legacy(&self) -> Result<LegacySecretsFile, String> {
        let path = self.legacy_path();
        if !path.is_file() {
            return Ok(LegacySecretsFile::default());
        }
        let raw = fs::read_to_string(&path).map_err(|err| format!("read secrets: {err}"))?;
        if raw.trim().is_empty() {
            return Ok(LegacySecretsFile::default());
        }
        serde_json::from_str(&raw).map_err(|err| format!("parse secrets: {err}"))
    }

    fn write_legacy_file(&self, file: &LegacySecretsFile) -> Result<(), String> {
        let path = self.legacy_path();
        if file.secrets.is_empty() {
            if path.is_file() {
                fs::remove_file(&path).map_err(|err| format!("remove secrets file: {err}"))?;
            }
            return Ok(());
        }
        fs::create_dir_all(&self.config_dir).map_err(|err| format!("create config dir: {err}"))?;
        let raw =
            serde_json::to_string_pretty(file).map_err(|err| format!("serialize secrets: {err}"))?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut out =
                fs::File::create(&tmp).map_err(|err| format!("create secrets tmp: {err}"))?;
            out.write_all(raw.as_bytes())
                .map_err(|err| format!("write secrets tmp: {err}"))?;
            out.sync_all().ok();
        }
        fs::rename(&tmp, &path).map_err(|err| format!("replace secrets file: {err}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn take_legacy_value(&self, key: &str) -> Result<Option<String>, String> {
        let file = self.read_legacy()?;
        Ok(file.secrets.get(key).cloned())
    }

    fn write_legacy_entry(&self, key: &str, value: &str) -> Result<(), String> {
        let mut file = self.read_legacy()?;
        file.secrets.insert(key.to_string(), value.to_string());
        self.write_legacy_file(&file)
    }

    fn remove_legacy_entry(&self, key: &str) -> Result<(), String> {
        let mut file = self.read_legacy()?;
        if file.secrets.remove(key).is_none() {
            return Ok(());
        }
        self.write_legacy_file(&file)
    }
}

pub fn normalize_secret_service(service: &str) -> Result<String, String> {
    let trimmed = service.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("service name must be 1..=64 characters".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("service name must be ascii alphanumeric/_/-".into());
    }
    Ok(trimmed.to_string())
}

/// Helper for tests / callers that already have a config directory Path.
#[allow(dead_code)]
pub fn legacy_path_for(config_dir: &Path) -> PathBuf {
    config_dir.join(LEGACY_SECRETS_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("holdem-study-secrets-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_legacy(dir: &Path, service: &str, value: &str) {
        let file = LegacySecretsFile {
            secrets: HashMap::from([(service.to_string(), value.to_string())]),
        };
        let path = dir.join(LEGACY_SECRETS_FILE);
        fs::write(path, serde_json::to_string_pretty(&file).unwrap()).unwrap();
    }

    #[test]
    fn memory_round_trip_and_clear() {
        let dir = temp_dir("roundtrip");
        let store = AssistantSecretStore::with_vault(dir.clone(), Box::new(MemoryVault::default()));
        assert_eq!(store.get("openai_assistant").unwrap(), None);
        store.set("openai_assistant", " sk-test ").unwrap();
        assert_eq!(
            store.get("openai_assistant").unwrap().as_deref(),
            Some("sk-test")
        );
        assert!(store.has("openai_assistant").unwrap());
        store.clear("openai_assistant").unwrap();
        assert!(!store.has("openai_assistant").unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_legacy_file_into_vault_on_read() {
        let dir = temp_dir("migrate");
        write_legacy(&dir, "openai_assistant", "sk-legacy");
        let store = AssistantSecretStore::with_vault(dir.clone(), Box::new(MemoryVault::default()));
        assert_eq!(
            store.get("openai_assistant").unwrap().as_deref(),
            Some("sk-legacy")
        );
        // Legacy file entry removed after successful migrate.
        assert!(!dir.join(LEGACY_SECRETS_FILE).is_file());
        // Still available from the vault.
        assert_eq!(
            store.get("openai_assistant").unwrap().as_deref(),
            Some("sk-legacy")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn set_prefers_vault_and_clears_legacy() {
        let dir = temp_dir("set-clears");
        write_legacy(&dir, "openai_assistant", "sk-old");
        let store = AssistantSecretStore::with_vault(dir.clone(), Box::new(MemoryVault::default()));
        store.set("openai_assistant", "sk-new").unwrap();
        assert!(!dir.join(LEGACY_SECRETS_FILE).is_file());
        assert_eq!(
            store.get("openai_assistant").unwrap().as_deref(),
            Some("sk-new")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn falls_back_to_legacy_file_when_vault_unavailable() {
        let dir = temp_dir("fallback");
        let store = AssistantSecretStore::with_vault(dir.clone(), Box::new(FailingVault));
        store.set("openai_assistant", "sk-fallback").unwrap();
        assert!(dir.join(LEGACY_SECRETS_FILE).is_file());
        assert_eq!(
            store.get("openai_assistant").unwrap().as_deref(),
            Some("sk-fallback")
        );
        store.clear("openai_assistant").unwrap();
        assert!(!dir.join(LEGACY_SECRETS_FILE).is_file());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bad_service_names() {
        assert!(normalize_secret_service("").is_err());
        assert!(normalize_secret_service("bad name").is_err());
        assert!(normalize_secret_service("ok_name-1").is_ok());
    }
}
