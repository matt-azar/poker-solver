// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Local crash / session-fault diagnostics for Holdem Study (ZR-160).
//!
//! Persists sidecar stderr, last-fault snapshots, and session meta under a
//! single folder the user can zip and share. No remote upload.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

const PRODUCT_DIR: &str = "Holdem Study";
const DIAGNOSTICS_SUBDIR: &str = "diagnostics";
const ENGINE_LOG: &str = "engine.log";
const LAST_FAULT: &str = "last-fault.json";
const LAST_SOLVE: &str = "last-solve.json";
const HOST_RESOURCES: &str = "host-resources.json";
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
  engine.log           — recent solver-engine stderr (rolling)
  last-fault.json      — last Solve failed / session-dead / kill / ensure-fail
  last-solve.json      — compact parameters of the last Solve (no range blobs)
  host-resources.json  — best-effort UI/sidecar RSS + system RAM/CPU
  session-meta.json    — app version, protocol, launch_id, OS

Timing:
  Before each Solve / Continue train start, Study writes a cheap pre-solve
  snapshot (last-solve.json + host-resources.json with snapshotKind=pre-solve)
  so a zip is still useful if the process dies before last-fault can write.
  Later fault writes overwrite host-resources with snapshotKind=fault and
  write last-fault.json. Compare timestamps / snapshotKind — do not treat a
  lone pre-solve host-resources file as post-crash state.

last-solve.json fields (typical):
  snapshotKind (pre-solve), timestamp, street, board, pot, stack, bet sizes,
  accuracy, iterations, threads, memoryMib, rake/ICM flags, algorithm, frozen,
  timeLimit, range hashes/sizes (not full range text), publishEveryHint

host-resources.json fields (best-effort; omitted when sampling fails):
  snapshotKind (pre-solve|fault), timestamp, uiRssBytes, sidecarPid,
  sidecarRssBytes, systemTotalRamBytes, systemAvailableRamBytes,
  cpuLoad1 (Linux), cpuPercentApprox (when a prior sample exists), os, note

Hard crash minidumps (if Windows LocalDumps is registered) land under:
  %LOCALAPPDATA%\\CrashDumps\\
  Look for Holdem Study.exe.*.dmp and solver-engine.exe.*.dmp

Do not include assistant API keys or full range text unless asked.
";

/// Last known solver-engine PID (for host-resources after UI-side faults).
static LAST_SIDECAR_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Remember / clear the live sidecar PID (spawn / kill).
pub fn remember_sidecar_pid(pid: Option<u32>) {
    if let Ok(mut slot) = LAST_SIDECAR_PID.lock() {
        *slot = pid;
    }
}

fn sidecar_pid_snapshot() -> Option<u32> {
    LAST_SIDECAR_PID.lock().ok().and_then(|g| *g)
}

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
///
/// Also refreshes `host-resources.json` on the same triggers (ZR-169).
pub fn write_last_fault(snapshot: &FaultSnapshot) {
    write_last_fault_with_sidecar(snapshot, sidecar_pid_snapshot());
}

/// Same as [`write_last_fault`] but samples a known sidecar PID (pre-kill).
pub fn write_last_fault_with_sidecar(snapshot: &FaultSnapshot, sidecar_pid: Option<u32>) {
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
    // Never let host sampling block or undo the fault write.
    write_host_resources_labeled(sidecar_pid, "fault", /*cheap*/ false);
}

/// Persist compact last-solve parameters from the Study UI (ZR-169).
///
/// Caller must omit secrets and full range catalogues; board + size lists OK.
pub fn write_last_solve(summary: &Value) {
    let Ok(dir) = ensure_diagnostics_dir() else {
        return;
    };
    let path = dir.join(LAST_SOLVE);
    match serde_json::to_string_pretty(summary) {
        Ok(body) => {
            if let Err(err) = fs::write(&path, body) {
                eprintln!("warn: diagnostics last-solve write failed: {err}");
            }
        }
        Err(err) => eprintln!("warn: diagnostics last-solve encode failed: {err}"),
    }
}

/// Cheap pre-solve / pre-continue snapshot so a zip stays useful if the process
/// dies before `last-fault.json` can be written (ZR-169).
///
/// Writes `last-solve.json` (caller summary + `snapshotKind: pre-solve`) and a
/// best-effort `host-resources.json` labeled the same. Skips expensive CPU
/// interval sampling; never blocks the Solve start path on sampling failure.
pub fn write_pre_solve_snapshot(summary: &Value) {
    let mut enriched = summary.clone();
    if let Some(obj) = enriched.as_object_mut() {
        obj.entry("snapshotKind".to_string())
            .or_insert_with(|| Value::String("pre-solve".into()));
        obj.entry("timestamp".to_string())
            .or_insert_with(|| Value::String(iso_timestamp()));
        obj.insert("uiVersion".to_string(), Value::String(UI_VERSION.into()));
    }
    write_last_solve(&enriched);
    write_host_resources_labeled(sidecar_pid_snapshot(), "pre-solve", /*cheap*/ true);
}

/// Convenience for Rust kill / ensure / pipe-death paths.
pub fn record_fault(
    launch_id: &str,
    last_op: Option<&str>,
    reason: &str,
    exit_reason: &str,
    protocol: u32,
) {
    record_fault_with_sidecar(
        launch_id,
        last_op,
        reason,
        exit_reason,
        protocol,
        sidecar_pid_snapshot(),
    );
}

/// Like [`record_fault`] with an explicit sidecar PID for RSS sampling.
pub fn record_fault_with_sidecar(
    launch_id: &str,
    last_op: Option<&str>,
    reason: &str,
    exit_reason: &str,
    protocol: u32,
    sidecar_pid: Option<u32>,
) {
    write_last_fault_with_sidecar(
        &FaultSnapshot {
            timestamp: iso_timestamp(),
            launch_id: launch_id.to_string(),
            last_op: last_op.map(|s| s.to_string()),
            reason: reason.to_string(),
            exit_reason: exit_reason.to_string(),
            ui_version: UI_VERSION.to_string(),
            protocol,
            consecutive_status_failures: None,
        },
        sidecar_pid,
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResources {
    pub timestamp: String,
    /// `pre-solve` | `fault` — distinguishes start snapshot from post-fault.
    pub snapshot_kind: String,
    pub os: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_rss_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar_rss_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_total_ram_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_available_ram_bytes: Option<u64>,
    /// Linux 1-minute load average (cheap).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_load1: Option<f64>,
    /// Approx CPU % from a prior sample delta (may be null on first sample).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent_approx: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Prior CPU tick sample for non-blocking percent approx (updated on each sample).
#[derive(Clone, Copy, Default)]
struct CpuTickSample {
    idle: u64,
    total: u64,
}

static LAST_CPU_TICKS: Mutex<Option<CpuTickSample>> = Mutex::new(None);

fn write_host_resources_labeled(sidecar_pid: Option<u32>, kind: &str, cheap: bool) {
    let sample = sample_host_resources(sidecar_pid, kind, cheap);
    let Ok(dir) = ensure_diagnostics_dir() else {
        return;
    };
    let path = dir.join(HOST_RESOURCES);
    match serde_json::to_string_pretty(&sample) {
        Ok(body) => {
            if let Err(err) = fs::write(&path, body) {
                eprintln!("warn: diagnostics host-resources write failed: {err}");
            }
        }
        Err(err) => eprintln!("warn: diagnostics host-resources encode failed: {err}"),
    }
}

fn sample_host_resources(sidecar_pid: Option<u32>, kind: &str, cheap: bool) -> HostResources {
    let ui_rss = process_rss_bytes(None);
    let sidecar_rss = sidecar_pid.and_then(|pid| process_rss_bytes(Some(pid)));
    let (total_ram, avail_ram) = system_ram_bytes();
    let load1 = cpu_load1();
    // Interval CPU % needs a prior sample; never sleep on the Solve path.
    let cpu_pct = if cheap {
        // Still refresh the tick baseline so a later fault can compute %.
        let _ = cpu_percent_approx_nonblocking();
        None
    } else {
        cpu_percent_approx_nonblocking()
    };
    let mut notes: Vec<&str> = Vec::new();
    if cheap {
        notes.push("cheap pre-solve sample (no CPU interval wait)");
    }
    if ui_rss.is_none() && total_ram.is_none() && load1.is_none() && cpu_pct.is_none() {
        notes.push("host sampling unavailable on this platform/build");
    }
    let note = if notes.is_empty() {
        None
    } else {
        Some(notes.join("; "))
    };
    HostResources {
        timestamp: iso_timestamp(),
        snapshot_kind: kind.to_string(),
        os: std::env::consts::OS.to_string(),
        ui_rss_bytes: ui_rss,
        sidecar_pid,
        sidecar_rss_bytes: sidecar_rss,
        system_total_ram_bytes: total_ram,
        system_available_ram_bytes: avail_ram,
        cpu_load1: load1,
        cpu_percent_approx: cpu_pct,
        note,
    }
}

fn process_rss_bytes(pid: Option<u32>) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let path = match pid {
            Some(p) => format!("/proc/{p}/status"),
            None => "/proc/self/status".to_string(),
        };
        let text = fs::read_to_string(path).ok()?;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("VmRSS:") {
                let kb: u64 = rest
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()?;
                return Some(kb.saturating_mul(1024));
            }
        }
        None
    }
    #[cfg(windows)]
    {
        windows_process_working_set(pid)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

fn system_ram_bytes() -> (Option<u64>, Option<u64>) {
    #[cfg(target_os = "linux")]
    {
        let text = match fs::read_to_string("/proc/meminfo") {
            Ok(t) => t,
            Err(_) => return (None, None),
        };
        let mut total = None;
        let mut avail = None;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                if let Some(kb) = rest.split_whitespace().next().and_then(|s| s.parse().ok()) {
                    total = Some(kb * 1024);
                }
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                if let Some(kb) = rest.split_whitespace().next().and_then(|s| s.parse().ok()) {
                    avail = Some(kb * 1024);
                }
            }
        }
        (total, avail)
    }
    #[cfg(windows)]
    {
        windows_system_ram()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        (None, None)
    }
}

fn cpu_load1() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let text = fs::read_to_string("/proc/loadavg").ok()?;
        text.split_whitespace().next()?.parse().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

fn cpu_percent_approx_nonblocking() -> Option<f64> {
    let now = read_cpu_ticks()?;
    let mut slot = LAST_CPU_TICKS.lock().ok()?;
    let prev = slot.replace(now)?;
    let total_delta = now.total.saturating_sub(prev.total);
    if total_delta == 0 {
        return None;
    }
    let idle_delta = now.idle.saturating_sub(prev.idle);
    let busy = total_delta.saturating_sub(idle_delta) as f64;
    Some(((busy / total_delta as f64) * 100.0).clamp(0.0, 100.0))
}

fn read_cpu_ticks() -> Option<CpuTickSample> {
    #[cfg(target_os = "linux")]
    {
        let text = fs::read_to_string("/proc/stat").ok()?;
        let line = text.lines().next()?;
        // cpu user nice system idle iowait irq softirq …
        let mut parts = line.split_whitespace();
        if parts.next()? != "cpu" {
            return None;
        }
        let mut vals: Vec<u64> = Vec::new();
        for p in parts.take(8) {
            vals.push(p.parse().ok()?);
        }
        if vals.len() < 4 {
            return None;
        }
        let idle = vals[3].saturating_add(if vals.len() > 4 { vals[4] } else { 0 });
        let total: u64 = vals.iter().sum();
        Some(CpuTickSample { idle, total })
    }
    #[cfg(windows)]
    {
        windows_cpu_ticks()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_system_ram() -> (Option<u64>, Option<u64>) {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: struct layout matches MEMORYSTATUSEX; length set correctly.
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return (None, None);
    }
    (Some(status.total_phys), Some(status.avail_phys))
}

#[cfg(windows)]
fn windows_process_working_set(pid: Option<u32>) -> Option<u64> {
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut core::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    // SAFETY: Win32 process handles; closed before return when opened.
    unsafe {
        let (handle, owned) = match pid {
            None => (GetCurrentProcess(), false),
            Some(p) => {
                let h = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                    0,
                    p,
                );
                if h.is_null() {
                    let h2 = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, p);
                    if h2.is_null() {
                        return None;
                    }
                    (h2, true)
                } else {
                    (h, true)
                }
            }
        };
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        if owned {
            let _ = CloseHandle(handle);
        }
        if ok == 0 {
            return None;
        }
        Some(counters.working_set_size as u64)
    }
}

#[cfg(windows)]
fn windows_cpu_ticks() -> Option<CpuTickSample> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(
            idle: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    let mut idle = 0u64;
    let mut kernel = 0u64;
    let mut user = 0u64;
    // SAFETY: out-params are valid stack u64s (FILETIME-sized).
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    // Kernel includes idle on Windows.
    let total = kernel.saturating_add(user);
    Some(CpuTickSample { idle, total })
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
        assert!(readme.contains("last-solve.json"));
        assert!(readme.contains("host-resources.json"));
        assert!(readme.contains("snapshotKind=pre-solve"));
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
        let host: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(HOST_RESOURCES)).unwrap()).unwrap();
        assert_eq!(host["snapshotKind"], "fault");
        assert!(host.get("os").is_some());
    }

    #[test]
    fn pre_solve_snapshot_labels_files() {
        let (dir, _guard) = isolated_dir("presolve");
        let summary = serde_json::json!({
            "street": "flop",
            "boardLen": 3,
            "board": ["Ah", "Kd", "7c"],
            "pot": 100,
            "stack": 1000,
            "iterations": 50,
            "memoryMib": 2048,
            "threads": 4,
            "ranges": {
                "oop": { "seat": "oop", "chars": 2, "hash": "deadbeef" },
                "ip": { "seat": "ip", "chars": 2, "hash": "cafebabe" }
            }
        });
        write_pre_solve_snapshot(&summary);
        let solve: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(LAST_SOLVE)).unwrap()).unwrap();
        assert_eq!(solve["snapshotKind"], "pre-solve");
        assert_eq!(solve["street"], "flop");
        assert_eq!(solve["boardLen"], 3);
        assert!(solve.get("oop_range").is_none());
        assert!(solve["ranges"]["oop"]["hash"].is_string());
        let host: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(HOST_RESOURCES)).unwrap()).unwrap();
        assert_eq!(host["snapshotKind"], "pre-solve");

        // Fault overwrites host-resources kind; last-solve stays pre-solve params.
        record_fault("zig-x", Some("solve"), "boom", "solve-failed", 2);
        let host2: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(HOST_RESOURCES)).unwrap()).unwrap();
        assert_eq!(host2["snapshotKind"], "fault");
        let solve2: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(LAST_SOLVE)).unwrap()).unwrap();
        assert_eq!(solve2["snapshotKind"], "pre-solve");
        assert_eq!(solve2["iterations"], 50);
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
