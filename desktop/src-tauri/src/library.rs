// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Packaged Study Library assets (templates / ranges) without holdem-explorer HTTP.
//!
//! After the Zig sidecar flip, Study still opens Library on boot/navigation and
//! used to `fetch http://127.0.0.1:8765/api/{templates,ranges,recent-solutions}`.
//! With no explorer listening, that paints `Engine unreachable: Failed to fetch`
//! even when solver-engine IPC is healthy. These commands read the NSIS-staged
//! `configs/templates` and `configs/ranges` trees beside the app (or under the
//! Tauri resource dir).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize)]
pub struct NamedEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextEntry {
    pub id: String,
    pub text: String,
}

fn existing_library_dir(app: &AppHandle, leaf: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("configs").join(leaf));
        candidates.push(resource.join(leaf));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("configs").join(leaf));
            candidates.push(dir.join("resources").join("configs").join(leaf));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("configs").join(leaf));
        candidates.push(cwd.join("..").join("configs").join(leaf));
        candidates.push(cwd.join("..").join("..").join("configs").join(leaf));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn is_safe_relative_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 256 {
        return false;
    }
    if id.starts_with('/') || id.starts_with('\\') || id.contains("..") {
        return false;
    }
    !id.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'))
}

fn id_to_rel_path(id: &str) -> PathBuf {
    // Library ids use `/` separators (e.g. open/jj-plus); map to OS path.
    PathBuf::from(id.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn stem_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string()
}

fn collect_txt_files(root: &Path, prefix: &str, out: &mut Vec<NamedEntry>) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|err| format!("read {}: {err}", root.display()))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("read {}: {err}", root.display()))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            dirs.push((name.to_string(), path));
        } else if path.extension().and_then(|e| e.to_str()) == Some("txt") {
            files.push((name.to_string(), path));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path) in files {
        let stem = stem_name(&path);
        let id = if prefix.is_empty() {
            stem.clone()
        } else {
            format!("{prefix}/{stem}")
        };
        let folder = if prefix.is_empty() {
            None
        } else {
            Some(prefix.to_string())
        };
        out.push(NamedEntry {
            id,
            name: stem,
            folder,
        });
        let _ = name;
    }
    for (name, path) in dirs {
        let next_prefix = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        collect_txt_files(&path, &next_prefix, out)?;
    }
    Ok(())
}

fn read_txt(root: &Path, id: &str) -> Result<TextEntry, String> {
    if !is_safe_relative_id(id) {
        return Err(format!("invalid library id `{id}`"));
    }
    let rel = id_to_rel_path(id);
    let mut path = root.join(&rel);
    if path.extension().and_then(|e| e.to_str()) != Some("txt") {
        path.set_extension("txt");
    }
    // Stay under root (reject escapes after join).
    let root_canon = fs::canonicalize(root).map_err(|err| format!("canonicalize {}: {err}", root.display()))?;
    let path_canon = fs::canonicalize(&path).map_err(|_| format!("unknown library id `{id}`"))?;
    if !path_canon.starts_with(&root_canon) {
        return Err(format!("invalid library id `{id}`"));
    }
    let text = fs::read_to_string(&path_canon).map_err(|err| format!("read `{id}`: {err}"))?;
    Ok(TextEntry {
        id: id.to_string(),
        text,
    })
}

#[tauri::command]
pub fn library_list_templates(app: AppHandle) -> Result<Vec<NamedEntry>, String> {
    let root = existing_library_dir(&app, "templates")
        .ok_or_else(|| "configs/templates not found beside the app".to_string())?;
    let mut out = Vec::new();
    collect_txt_files(&root, "", &mut out)?;
    // Templates list historically omitted folder.
    for entry in &mut out {
        entry.folder = None;
    }
    Ok(out)
}

#[tauri::command]
pub fn library_list_ranges(app: AppHandle) -> Result<Vec<NamedEntry>, String> {
    let root = existing_library_dir(&app, "ranges")
        .ok_or_else(|| "configs/ranges not found beside the app".to_string())?;
    let mut out = Vec::new();
    collect_txt_files(&root, "", &mut out)?;
    Ok(out)
}

#[tauri::command]
pub fn library_read_template(app: AppHandle, id: String) -> Result<TextEntry, String> {
    let root = existing_library_dir(&app, "templates")
        .ok_or_else(|| "configs/templates not found beside the app".to_string())?;
    read_txt(&root, &id)
}

#[tauri::command]
pub fn library_read_range(app: AppHandle, id: String) -> Result<TextEntry, String> {
    let root = existing_library_dir(&app, "ranges")
        .ok_or_else(|| "configs/ranges not found beside the app".to_string())?;
    read_txt(&root, &id)
}

/// Recent PSOL list was explorer-owned; Zig IPC has no recent DB yet.
#[tauri::command]
pub fn library_list_recent() -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}
