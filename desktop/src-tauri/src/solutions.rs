// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Managed solutions directory for the in-app solutions catalogue.
//!
//! Packaged Study stores catalogue `.psol` files under
//! `%LOCALAPPDATA%/Holdem Study/solutions` (or XDG data home on Linux) so
//! primary Save/Open never requires an OS file picker.

use std::fs;
use std::path::{Path, PathBuf};

const PRODUCT_DIR: &str = "Holdem Study";
const SOLUTIONS_SUBDIR: &str = "solutions";

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

fn solutions_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("HOLDEM_STUDY_SOLUTIONS_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    local_app_data_root()
        .join(PRODUCT_DIR)
        .join(SOLUTIONS_SUBDIR)
}

fn is_safe_relative_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 512 {
        return false;
    }
    if key.starts_with('/') || key.starts_with('\\') || key.contains("..") {
        return false;
    }
    !key
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'))
}

fn relative_to_path(key: &str) -> PathBuf {
    PathBuf::from(key.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// Ensure the solutions root exists and return its absolute path.
#[tauri::command]
pub fn solutions_root() -> Result<String, String> {
    let dir = solutions_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("create solutions root: {err}"))?;
    let canon = fs::canonicalize(&dir).unwrap_or(dir);
    Ok(canon.to_string_lossy().into_owned())
}

/// Ensure parent directories exist for a catalogue-relative key (`folder/name.psol`).
#[tauri::command]
pub fn solutions_ensure_parent(relative_key: String) -> Result<(), String> {
    if !is_safe_relative_key(&relative_key) {
        return Err(format!("invalid solutions key `{relative_key}`"));
    }
    let root = solutions_dir();
    fs::create_dir_all(&root).map_err(|err| format!("create solutions root: {err}"))?;
    let full = root.join(relative_to_path(&relative_key));
    let parent = full
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.clone());
    // Stay under root.
    let root_canon =
        fs::canonicalize(&root).map_err(|err| format!("canonicalize {}: {err}", root.display()))?;
    // Parent may not exist yet — canonicalize root and check prefix logically.
    let parent_stripped = parent.strip_prefix(&root).unwrap_or(parent.as_path());
    let candidate = root_canon.join(parent_stripped);
    if !candidate.starts_with(&root_canon) {
        return Err(format!("invalid solutions key `{relative_key}`"));
    }
    fs::create_dir_all(&candidate).map_err(|err| format!("create solutions folder: {err}"))?;
    Ok(())
}
