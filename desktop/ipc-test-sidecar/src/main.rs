// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Controllable protocol-2 sidecar for async IPC acceptance tests.
//!
//! Standalone crate (no Tauri/GTK) so Linux CI and Windows packaged harnesses
//! can build it without webview deps. Behavior mirrors
//! `scripts/desktop/ipc_test_sidecar.py`.

use std::io::{self, Read, Write};

use serde_json::{json, Value};

fn read_frame(stdin: &mut impl Read, stash: &mut Vec<u8>) -> io::Result<Value> {
    while stash.len() < 4 {
        let mut chunk = [0u8; 4096];
        let n = stdin.read(&mut chunk)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "stdin closed"));
        }
        stash.extend_from_slice(&chunk[..n]);
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&stash[..4]);
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len == 0 || len > 16 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad frame length {len}"),
        ));
    }
    while stash.len() < 4 + len {
        let mut chunk = [0u8; 8192];
        let n = stdin.read(&mut chunk)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "stdin closed mid-frame",
            ));
        }
        stash.extend_from_slice(&chunk[..n]);
    }
    let payload = stash[4..4 + len].to_vec();
    stash.drain(..4 + len);
    serde_json::from_slice(&payload).map_err(|err| {
        io::Error::new(io::ErrorKind::InvalidData, format!("json decode: {err}"))
    })
}

fn write_frame(stdout: &mut impl Write, envelope: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(envelope)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    stdout.write_all(&(payload.len() as u32).to_le_bytes())?;
    stdout.write_all(&payload)?;
    stdout.flush()?;
    Ok(())
}

fn reply_ok(request_id: &str, op: &str, job_id: Option<&str>, body: Value) -> Value {
    json!({
        "v": 2,
        "kind": "reply",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "ok": true,
        "body": body,
    })
}

fn main() {
    let mut launch_id = "local".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--launch-id" {
            if let Some(v) = args.next() {
                launch_id = v;
            }
        }
    }

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let mut stash = Vec::new();
    let mut withheld_values = false;

    loop {
        let req = match read_frame(&mut stdin, &mut stash) {
            Ok(v) => v,
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(err) => {
                eprintln!("ipc-test-sidecar read error: {err}");
                break;
            }
        };
        let kind = req.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "request" {
            continue;
        }
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let request_id = req
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let job_id = req
            .get("job_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let body = match op.as_str() {
            "ready" => json!({
                "protocol": 2,
                "sidecar": "ipc-test-sidecar",
                "launch_id": launch_id,
                "workers": 1,
            }),
            "status" => json!({
                "phase": "idle",
                "solving": false,
                "iterations": 0,
                "iterations_requested": 0,
                "solution_id": 1,
                "held_values": withheld_values,
            }),
            "cancel" => json!({
                "cancelled": true,
                "reason": "test-sidecar-ack",
            }),
            "pause" => json!({ "paused": true }),
            // ZR-106 short-admit shape — reply immediately; Study polls status.
            "solve" | "resolve_locked" => json!({
                "accepted": true,
                "running": true,
                "solution_id": 1,
                "threads": 1,
            }),
            "values" | "equity" => {
                if !withheld_values {
                    withheld_values = true;
                    eprintln!(
                        "ipc-test-sidecar: withholding {op} reply for {request_id} (still reading)"
                    );
                    continue;
                }
                json!({ "ok": true, "actions": [], "note": "late-or-second-values" })
            }
            _ => json!({ "echo_op": op }),
        };

        if let Err(err) = write_frame(
            &mut stdout,
            &reply_ok(&request_id, &op, job_id.as_deref(), body),
        ) {
            eprintln!("ipc-test-sidecar write error: {err}");
            break;
        }
    }
}
