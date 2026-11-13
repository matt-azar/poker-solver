// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Local crash / session-fault diagnostics for Holdem Study (ZR-160).
//!
//! Persists sidecar stderr, last-fault snapshots, and session meta under a
//! single folder the user can zip and share. No remote upload.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const PRODUCT_DIR: &str = "Holdem Study";
const DIAGNOSTICS_SUBDIR: &str = "diagnostics";
const ENGINE_LOG: &str = "engine.log";
const LAST_FAULT: &str = "last-fault.json";
const SESSION_META: &str = "session-meta.json";
const README_NAME: &str = "README.txt";
const OVERRIDE_ENV: &str = "HOLDEM_STUDY_DIAGNOSTICS_DIR";
/// Soft cap for rolling sidecar stderr (bytes). Spec: ~1–2 MB.
const ENGINE_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const UI_VERSION: &str = env!("CARGO_PKG_VERSION");

const README_BODY: &str = "\
Holdem Study diagnostics
========================

Zip this folder and send it when reporting a hang, crash, Solve failed, or
engine failure.

Folder (Windows packaged):
  %LOCALAPPDATA%\\Holdem Study\\diagnostics\\

Contents:
  engine.log        — recent solver-engine stderr (rolling)
  last-fault.json   — last Solve failed / session-dead / kill / ensure-fail
  session-meta.json — app version, protocol, launch_id, OS

Hard crash minidumps (if Windows LocalDumps is registered) land under:
  %LOCALAPPDATA%\\CrashDumps\\
  Look for Holdem Study.exe.*.dmp and solver-engine.exe.*.dmp

Do not include assistant API keys or full range text unless asked.
";

/// Resolve the diagnostics directory (creates nothing).
///
/// Override with `HOLDEM_STUDY_DIAGNOSTICS_DIR` (tests / support).
/// Packaged Windows: `%LOCALAPPDATA%\\Holdem Study\\diagnostics`.
pub fn diagnostics_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var(OVERRIDE_ENV) {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    local_app_data_root().join(PRODUCT_DIR).join(DIAGNOSTICS_SUBDIR)
}

fn local_app_data_root() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let trimmed = local.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local").join("share");
    }
    std::env::temp_dir()
}

/// Ensure the diagnostics folder exists and has a short README.
pub fn ensure_diagnostics_dir() -> Result<PathBuf, String> {
    let dir = diagnostics_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("create diagnostics dir: {err}"))?;
    let readme = dir.join(README_NAME);
    // Refresh README so folder-path / Solve-failed guidance stays current (ZR-163).
    fs::write(&readme, README_BODY).map_err(|err| format!("write diagnostics README: {err}"))?;
    Ok(dir)
}

fn iso_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Compact UTC-ish stamp without extra deps (good enough for fault files).
    format!("{secs}")
}

/// Append sidecar stderr to the rolling `engine.log` (also keep eprint! callers).
pub fn append_engine_log(chunk: &[u8]) {
    if chunk.is_empty() {
        return;
    }
    let Ok(dir) = ensure_diagnostics_dir() else {
        return;
    };
    let path = dir.join(ENGINE_LOG);
    if let Err(err) = append_and_rotate(&path, chunk, ENGINE_LOG_MAX_BYTES) {
        eprintln!("warn: diagnostics engine.log write failed: {err}");
    }
}

fn append_and_rotate(path: &Path, chunk: &[u8], max_bytes: u64) -> Result<(), String> {
    {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| format!("open engine.log: {err}"))?;
        file.write_all(chunk)
            .map_err(|err| format!("append engine.log: {err}"))?;
    }
    let meta = fs::metadata(path).map_err(|err| format!("stat engine.log: {err}"))?;
    if meta.len() <= max_bytes {
        return Ok(());
    }
    // Keep the trailing half so recent stderr survives after a hang.
    let keep = (max_bytes / 2).max(64 * 1024) as usize;
    let mut file = File::open(path).map_err(|err| format!("reopen engine.log: {err}"))?;
    let len = meta.len() as usize;
    let start = len.saturating_sub(keep);
    file.seek(SeekFrom::Start(start as u64))
        .map_err(|err| format!("seek engine.log: {err}"))?;
    let mut buf = Vec::with_capacity(keep);
    file.read_to_end(&mut buf)
        .map_err(|err| format!("read engine.log tail: {err}"))?;
    // Drop a partial first line after seek.
    if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
        if nl + 1 < buf.len() {
            buf = buf.split_off(nl + 1);
        }
    }
    fs::write(path, &buf).map_err(|err| format!("truncate engine.log: {err}"))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultSnapshot {
    pub timestamp: String,
    pub launch_id: String,
    pub last_op: Option<String>,
    pub reason: String,
    pub exit_reason: String,
    pub ui_version: String,
    pub protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consecutive_status_failures: Option<u32>,
}

/// Write `last-fault.json` (best-effort; never panics into the UI path).
pub fn write_last_fault(snapshot: &FaultSnapshot) {
    let Ok(dir) = ensure_diagnostics_dir() else {
        return;
    };
    let path = dir.join(LAST_FAULT);
    match serde_json::to_string_pretty(snapshot) {
        Ok(body) => {
            if let Err(err) = fs::write(&path, body) {
                eprintln!("warn: diagnostics last-fault write failed: {err}");
            }
        }
        Err(err) => eprintln!("warn: diagnostics last-fault encode failed: {err}"),
    }
}

/// Convenience for Rust kill / ensure / pipe-death paths.
pub fn record_fault(
    launch_id: &str,
    last_op: Option<&str>,
    reason: &str,
    exit_reason: &str,
    protocol: u32,
) {
    write_last_fault(&FaultSnapshot {
        timestamp: iso_timestamp(),
        launch_id: launch_id.to_string(),
        last_op: last_op.map(|s| s.to_string()),
        reason: reason.to_string(),
        exit_reason: exit_reason.to_string(),
        ui_version: UI_VERSION.to_string(),
        protocol,
        consecutive_status_failures: None,
    });
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub ui_version: String,
    pub protocol: u32,
    pub launch_id: String,
    pub workers: u32,
    pub sidecar: String,
    pub os: String,
    pub install_dir: Option<String>,
    pub diagnostics_dir: String,
}

/// Write `session-meta.json` after a successful ready handshake.
pub fn write_session_meta(
    launch_id: &str,
    protocol: u32,
    workers: u32,
    sidecar: &str,
) {
    let Ok(dir) = ensure_diagnostics_dir() else {
        return;
    };
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.display().to_string()));
    let meta = SessionMeta {
        ui_version: UI_VERSION.to_string(),
        protocol,
        launch_id: launch_id.to_string(),
        workers,
        sidecar: sidecar.to_string(),
        os: std::env::consts::OS.to_string(),
        install_dir,
        diagnostics_dir: dir.display().to_string(),
    };
    let path = dir.join(SESSION_META);
    match serde_json::to_string_pretty(&meta) {
        Ok(body) => {
            if let Err(err) = fs::write(&path, body) {
                eprintln!("warn: diagnostics session-meta write failed: {err}");
            }
        }
        Err(err) => eprintln!("warn: diagnostics session-meta encode failed: {err}"),
    }
}

/// Open the diagnostics folder in the OS file manager.
pub fn open_diagnostics_folder() -> Result<String, String> {
    let dir = ensure_diagnostics_dir()?;
    open_path_in_file_manager(&dir)?;
    Ok(dir.display().to_string())
}

fn open_path_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|err| format!("open diagnostics folder: {err}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("open diagnostics folder: {err}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("open diagnostics folder: {err}"))?;
        return Ok(());
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        Err("open diagnostics folder unsupported on this OS".into())
    }
}

/// Build a zip of the diagnostics folder (store-only, no extra crate).
/// Returns the zip path (also suitable to copy into chat).
pub fn bundle_diagnostics_zip() -> Result<String, String> {
    let dir = ensure_diagnostics_dir()?;
    let stamp = iso_timestamp();
    let zip_path = dir
        .parent()
        .unwrap_or(dir.as_path())
        .join(format!("holdem-study-diagnostics-{stamp}.zip"));
    write_stored_zip(&dir, &zip_path)?;
    Ok(zip_path.display().to_string())
}

fn write_stored_zip(source_dir: &Path, zip_path: &Path) -> Result<(), String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let read_dir =
        fs::read_dir(source_dir).map_err(|err| format!("read diagnostics dir: {err}"))?;
    for entry in read_dir {
        let entry = entry.map_err(|err| format!("diagnostics dir entry: {err}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .to_string_lossy()
            .replace('\\', "/");
        // Skip prior zips sitting beside the folder contents.
        if name.ends_with(".zip") {
            continue;
        }
        let data = fs::read(&path).map_err(|err| format!("read {name}: {err}"))?;
        entries.push((name, data));
    }
    if entries.is_empty() {
        // Always include README so the zip is non-empty.
        entries.push((README_NAME.to_string(), README_BODY.as_bytes().to_vec()));
    }

    let mut out = File::create(zip_path).map_err(|err| format!("create zip: {err}"))?;
    let mut central: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;
    for (name, data) in &entries {
        let name_bytes = name.as_bytes();
        if name_bytes.len() > u16::MAX as usize {
            return Err(format!("zip entry name too long: {name}"));
        }
        let local_header_size = 30 + name_bytes.len() as u32;
        let crc = crc32_ieee(data);
        let size = data.len() as u32;

        // Local file header.
        out.write_all(&[0x50, 0x4b, 0x03, 0x04]).map_err(io_err)?;
        out.write_all(&20u16.to_le_bytes()).map_err(io_err)?; // version needed
        out.write_all(&0u16.to_le_bytes()).map_err(io_err)?; // flags
        out.write_all(&0u16.to_le_bytes()).map_err(io_err)?; // method store
        out.write_all(&0u16.to_le_bytes()).map_err(io_err)?; // time
        out.write_all(&0u16.to_le_bytes()).map_err(io_err)?; // date
        out.write_all(&crc.to_le_bytes()).map_err(io_err)?;
        out.write_all(&size.to_le_bytes()).map_err(io_err)?;
        out.write_all(&size.to_le_bytes()).map_err(io_err)?;
        out.write_all(&(name_bytes.len() as u16).to_le_bytes())
            .map_err(io_err)?;
        out.write_all(&0u16.to_le_bytes()).map_err(io_err)?; // extra
        out.write_all(name_bytes).map_err(io_err)?;
        out.write_all(data).map_err(io_err)?;

        // Central directory header.
        central.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // int attr
        central.extend_from_slice(&0u32.to_le_bytes()); // ext attr
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);

        offset = offset
            .checked_add(local_header_size)
            .and_then(|o| o.checked_add(size))
            .ok_or_else(|| "zip offset overflow".to_string())?;
    }

    let central_offset = offset;
    let central_size = central.len() as u32;
    out.write_all(&central).map_err(io_err)?;

    // End of central directory.
    out.write_all(&[0x50, 0x4b, 0x05, 0x06]).map_err(io_err)?;
    out.write_all(&0u16.to_le_bytes()).map_err(io_err)?;
    out.write_all(&0u16.to_le_bytes()).map_err(io_err)?;
    let n = entries.len() as u16;
    out.write_all(&n.to_le_bytes()).map_err(io_err)?;
    out.write_all(&n.to_le_bytes()).map_err(io_err)?;
    out.write_all(&central_size.to_le_bytes()).map_err(io_err)?;
    out.write_all(&central_offset.to_le_bytes()).map_err(io_err)?;
    out.write_all(&0u16.to_le_bytes()).map_err(io_err)?;
    out.flush().map_err(io_err)?;
    Ok(())
}

fn io_err(err: std::io::Error) -> String {
    format!("zip io: {err}")
}

/// IEEE CRC-32 (ZIP).
fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = if crc & 1 != 0 { 0xEDB8_8320 } else { 0 };
            crc = (crc >> 1) ^ mask;
        }
    }
    !crc
}

/// Register Windows LocalDumps for the UI + sidecar (HKCU). Idempotent.
pub fn register_local_dumps() -> Result<(), String> {
    #[cfg(windows)]
    {
        register_local_dumps_windows()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(windows)]
fn register_local_dumps_windows() -> Result<(), String> {
    let crash_dir = local_app_data_root().join("CrashDumps");
    fs::create_dir_all(&crash_dir).map_err(|err| format!("create CrashDumps: {err}"))?;
    let dump_folder = crash_dir.display().to_string();

    let mut exe_names: Vec<String> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(name) = exe.file_name().and_then(|n| n.to_str()) {
            exe_names.push(name.to_string());
        }
    }
    // Packaged productName may differ from cargo bin name — cover both.
    for name in ["Holdem Study.exe", "poker-solver-study.exe", "solver-engine.exe"] {
        if !exe_names.iter().any(|e| e.eq_ignore_ascii_case(name)) {
            exe_names.push(name.to_string());
        }
    }

    for name in exe_names {
        set_local_dump_key(&name, &dump_folder)?;
    }
    Ok(())
}

#[cfg(windows)]
fn set_local_dump_key(exe_name: &str, dump_folder: &str) -> Result<(), String> {
    // Prefer reg.exe so we stay dependency-free on rustc 1.83.
    let key = format!(
        r"HKCU\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\{exe_name}"
    );
    let status = std::process::Command::new("reg")
        .args([
            "add",
            &key,
            "/v",
            "DumpFolder",
            "/t",
            "REG_EXPAND_SZ",
            "/d",
            dump_folder,
            "/f",
        ])
        .status()
        .map_err(|err| format!("reg DumpFolder: {err}"))?;
    if !status.success() {
        return Err(format!("reg DumpFolder failed for {exe_name}"));
    }
    let status = std::process::Command::new("reg")
        .args(["add", &key, "/v", "DumpCount", "/t", "REG_DWORD", "/d", "5", "/f"])
        .status()
        .map_err(|err| format!("reg DumpCount: {err}"))?;
    if !status.success() {
        return Err(format!("reg DumpCount failed for {exe_name}"));
    }
    let status = std::process::Command::new("reg")
        .args(["add", &key, "/v", "DumpType", "/t", "REG_DWORD", "/d", "1", "/f"])
        .status()
        .map_err(|err| format!("reg DumpType: {err}"))?;
    if !status.success() {
        return Err(format!("reg DumpType failed for {exe_name}"));
    }
    let _ = status;
    Ok(())
}

/// Path string for UI clipboard when zip is unavailable.
pub fn diagnostics_dir_path_string() -> Result<String, String> {
    Ok(ensure_diagnostics_dir()?.display().to_string())
}

/// Build a fault snapshot from a frontend report (status-poll death, etc.).
pub fn fault_from_ui_report(
    launch_id: Option<String>,
    last_op: Option<String>,
    reason: String,
    exit_reason: Option<String>,
    consecutive_status_failures: Option<u32>,
    protocol: u32,
) -> FaultSnapshot {
    FaultSnapshot {
        timestamp: iso_timestamp(),
        launch_id: launch_id.unwrap_or_else(|| "unknown".into()),
        last_op,
        reason,
        exit_reason: exit_reason.unwrap_or_else(|| "session-dead".into()),
        ui_version: UI_VERSION.to_string(),
        protocol,
        consecutive_status_failures,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        prev: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(OVERRIDE_ENV, v),
                None => std::env::remove_var(OVERRIDE_ENV),
            }
        }
    }

    fn isolated_dir(label: &str) -> (PathBuf, EnvGuard) {
        let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var(OVERRIDE_ENV).ok();
        let n = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("holdem-diag-{label}-{nanos}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp");
        std::env::set_var(OVERRIDE_ENV, &dir);
        (
            dir,
            EnvGuard {
                prev,
                _lock: lock,
            },
        )
    }

    #[test]
    fn ensure_dir_writes_readme() {
        let (dir, _guard) = isolated_dir("readme");
        let got = ensure_diagnostics_dir().expect("ensure");
        assert_eq!(got, dir);
        let readme = fs::read_to_string(dir.join(README_NAME)).expect("readme");
        assert!(readme.contains("Zip this folder"));
    }

    #[test]
    fn append_engine_log_rotates_at_cap() {
        let (dir, _guard) = isolated_dir("rotate");
        let _ = ensure_diagnostics_dir();
        let chunk = vec![b'x'; 8192];
        let rounds = (ENGINE_LOG_MAX_BYTES as usize / chunk.len()) + 4;
        for _ in 0..rounds {
            append_engine_log(&chunk);
        }
        let path = dir.join(ENGINE_LOG);
        let len = fs::metadata(&path).expect("meta").len();
        assert!(
            len <= ENGINE_LOG_MAX_BYTES,
            "log grew past cap: {len} > {ENGINE_LOG_MAX_BYTES}"
        );
        assert!(len > 0);
    }

    #[test]
    fn last_fault_and_session_meta_round_trip() {
        let (dir, _guard) = isolated_dir("fault");
        record_fault("zig-abc", Some("status"), "pipe closed", "session-dead", 2);
        write_session_meta("zig-abc", 2, 4, "solver-engine");
        let fault: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(LAST_FAULT)).unwrap()).unwrap();
        assert_eq!(fault["launchId"], "zig-abc");
        assert_eq!(fault["lastOp"], "status");
        assert_eq!(fault["uiVersion"], UI_VERSION);
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SESSION_META)).unwrap()).unwrap();
        assert_eq!(meta["protocol"], 2);
        assert_eq!(meta["workers"], 4);
    }

    #[test]
    fn bundle_zip_contains_local_header_signature() {
        let (dir, _guard) = isolated_dir("zip");
        let _ = ensure_diagnostics_dir();
        fs::write(dir.join("engine.log"), b"stderr line\n").unwrap();
        record_fault("zig-1", None, "test", "kill", 2);
        let zip = bundle_diagnostics_zip().expect("zip");
        let bytes = fs::read(&zip).expect("read zip");
        assert_eq!(&bytes[0..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert!(bytes.windows(4).any(|w| w == [0x50, 0x4b, 0x01, 0x02]));
    }

    #[test]
    fn crc32_known_vector() {
        assert_eq!(crc32_ieee(b"123456789"), 0xCBF4_3926);
    }
}
