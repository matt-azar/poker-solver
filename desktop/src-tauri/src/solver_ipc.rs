// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Typed protocol-2 envelopes, IPC error taxonomy, reply validation, and
//! bounded per-launch diagnostics (PR3).
//!
//! Zig `solver-engine` stays on protocol 2 (LE u32 + JSON). Rust owns the
//! connection from spawn through exit and classifies failures so Study can
//! distinguish degraded status responsiveness from connection loss.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

/// Protocol version spoken by Zig `solver-engine` and the test sidecar.
pub const PROTOCOL: u32 = 2;

/// Cap on retained diagnostic samples per launch (bounded ring).
pub const DIAG_RING_CAP: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IpcFrameKind {
    Request,
    Reply,
    Progress,
}

/// Outbound request envelope (serde; preserves field order via json! at encode).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRequestEnvelope {
    pub v: u32,
    pub kind: IpcFrameKind,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub op: String,
    #[serde(default)]
    pub body: Value,
}

/// Inbound reply envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcReplyEnvelope {
    pub v: u32,
    pub kind: IpcFrameKind,
    pub request_id: String,
    #[serde(default)]
    pub job_id: Option<String>,
    pub op: String,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub body: Value,
}

/// When a deadline expired relative to the stdin write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutPhase {
    /// Never reached the sidecar (safe to retry).
    BeforeWrite,
    /// Write completed; mutating outcomes are unknown (do not auto-replay).
    AfterWrite,
    /// Awaiting reply (status soft timeout = degraded, not connection loss).
    ReplyWait,
}

/// Rust-owned IPC failure taxonomy (Tauri serializes this on invoke Err).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "class", rename_all = "snake_case")]
pub enum IpcError {
    QueueSaturation {
        message: String,
    },
    Timeout {
        phase: TimeoutPhase,
        message: String,
        op: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        /// Soft status / EV timeouts are degraded responsiveness, not pipe death.
        degraded: bool,
    },
    EngineRejection {
        error_code: String,
        error_message: String,
        op: String,
        request_id: String,
    },
    ProtocolFailure {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        op: Option<String>,
    },
    ConnectionLoss {
        message: String,
        launch_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        child_exit: Option<String>,
    },
}

impl IpcError {
    pub fn queue_saturation(message: impl Into<String>) -> Self {
        Self::QueueSaturation {
            message: message.into(),
        }
    }

    pub fn timeout(
        phase: TimeoutPhase,
        message: impl Into<String>,
        op: impl Into<String>,
        request_id: Option<String>,
        degraded: bool,
    ) -> Self {
        Self::Timeout {
            phase,
            message: message.into(),
            op: op.into(),
            request_id,
            degraded,
        }
    }

    pub fn protocol_failure(
        message: impl Into<String>,
        request_id: Option<String>,
        op: Option<String>,
    ) -> Self {
        Self::ProtocolFailure {
            message: message.into(),
            request_id,
            op,
        }
    }

    pub fn connection_loss(
        message: impl Into<String>,
        launch_id: impl Into<String>,
        child_exit: Option<String>,
    ) -> Self {
        Self::ConnectionLoss {
            message: message.into(),
            launch_id: launch_id.into(),
            child_exit,
        }
    }

    /// True when Study must re-ensure (pipe/EOF/session death), not soft timeout.
    pub fn is_connection_loss(&self) -> bool {
        matches!(self, Self::ConnectionLoss { .. })
            || matches!(
                self,
                Self::ProtocolFailure { message, .. }
                    if message_implies_framing_death(message)
            )
    }

    /// Map admission / legacy string errors into the typed taxonomy.
    pub fn from_transport_message(message: &str, launch_id: &str, op: &str) -> Self {
        let lower = message.to_lowercase();
        if lower.contains("admission saturated") || lower.contains("queued bytes") {
            return Self::queue_saturation(message.to_string());
        }
        if lower.contains("expired-before-write") {
            return Self::timeout(
                TimeoutPhase::BeforeWrite,
                message.to_string(),
                op,
                None,
                false,
            );
        }
        if lower.contains("unknown-after-write") {
            return Self::timeout(
                TimeoutPhase::AfterWrite,
                message.to_string(),
                op,
                None,
                false,
            );
        }
        if lower.contains("timed out") || lower.contains("ipc read timed out") {
            let degraded = op == "status" || lower.contains("degraded");
            return Self::timeout(
                TimeoutPhase::ReplyWait,
                message.to_string(),
                op,
                None,
                degraded,
            );
        }
        if lower.contains("pipe closed")
            || lower.contains("broken pipe")
            || lower.contains("write:")
            || lower.contains("shut down")
            || lower.contains("session killed")
            || lower.contains("writer closed")
            || lower.contains("writer dropped")
            || lower.contains("unexpected eof")
            || lower.contains("stdout eof")
        {
            return Self::connection_loss(message.to_string(), launch_id, None);
        }
        if lower.contains("protocol")
            || lower.contains("invalid_frame")
            || lower.contains("malformed")
            || lower.contains("decode ipc")
        {
            return Self::protocol_failure(message.to_string(), None, Some(op.to_string()));
        }
        // Default: treat unknown transport strings as protocol/transport faults.
        Self::protocol_failure(message.to_string(), None, Some(op.to_string()))
    }
}

fn message_implies_framing_death(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("malformed")
        || lower.contains("invalid frame length")
        || lower.contains("unexpected eof")
        || lower.contains("decode ipc")
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueueSaturation { message } => write!(f, "{message}"),
            Self::Timeout { message, .. } => write!(f, "{message}"),
            Self::EngineRejection {
                error_code,
                error_message,
                ..
            } => write!(f, "{error_code}: {error_message}"),
            Self::ProtocolFailure { message, .. } => write!(f, "{message}"),
            Self::ConnectionLoss {
                message,
                launch_id,
                child_exit,
            } => {
                write!(f, "connection_loss: {message} (launch {launch_id}")?;
                if let Some(exit) = child_exit {
                    write!(f, ", exit {exit}")?;
                }
                write!(f, ")")
            }
        }
    }
}

impl std::error::Error for IpcError {}

/// Metadata for one in-flight request awaiting a demuxed reply.
pub struct PendingWaiter {
    pub tx: oneshot::Sender<Result<Value, IpcError>>,
    pub op: String,
    pub job_id: Option<String>,
    #[allow(dead_code)] // retained for future queue-wait attribution on the waiter
    pub admitted_at: Instant,
    pub wrote_at: Option<Instant>,
}

/// Outcome of validating a reply against the pending waiter.
#[derive(Debug)]
pub enum ReplyValidation {
    Ok,
    /// Drop silently (progress, orphan after timeout, superseded launch).
    Ignore(&'static str),
    /// Fail this waiter only.
    Reject(IpcError),
}

/// Validate protocol version, request id, op, and job id where applicable.
pub fn validate_reply(
    reply: &Value,
    pending: Option<&PendingWaiter>,
    expected_request_id: &str,
) -> ReplyValidation {
    let v = reply.get("v").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    if v != PROTOCOL {
        return ReplyValidation::Reject(IpcError::protocol_failure(
            format!("unsupported solver-engine protocol {v}"),
            Some(expected_request_id.to_string()),
            pending.map(|p| p.op.clone()),
        ));
    }
    let kind = reply.get("kind").and_then(|x| x.as_str()).unwrap_or("");
    if kind == "progress" {
        return ReplyValidation::Ignore("progress");
    }
    if kind != "reply" {
        return ReplyValidation::Ignore("non-reply");
    }
    let rid = reply
        .get("request_id")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if rid != expected_request_id {
        return ReplyValidation::Reject(IpcError::protocol_failure(
            format!("reply request_id mismatch: got {rid}, expected {expected_request_id}"),
            Some(expected_request_id.to_string()),
            pending.map(|p| p.op.clone()),
        ));
    }
    let Some(waiter) = pending else {
        // Orphan / late after timeout — drop (launch-scoped: never invent state).
        return ReplyValidation::Ignore("orphan");
    };
    let reply_op = reply.get("op").and_then(|x| x.as_str()).unwrap_or("");
    if !reply_op.is_empty() && reply_op != waiter.op {
        return ReplyValidation::Reject(IpcError::protocol_failure(
            format!(
                "reply op mismatch: got {reply_op}, expected {} (request {expected_request_id})",
                waiter.op
            ),
            Some(expected_request_id.to_string()),
            Some(waiter.op.clone()),
        ));
    }
    // Job id: when the request carried one, the reply must echo it (or null-only
    // when both sides omit). Mismatch is a protocol failure for that waiter.
    if let Some(ref expected_job) = waiter.job_id {
        let reply_job = reply
            .get("job_id")
            .and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str().map(|s| s.to_string())
                }
            });
        match reply_job {
            Some(ref got) if got == expected_job => {}
            Some(got) => {
                return ReplyValidation::Reject(IpcError::protocol_failure(
                    format!(
                        "reply job_id mismatch: got {got}, expected {expected_job} \
                         (request {expected_request_id})"
                    ),
                    Some(expected_request_id.to_string()),
                    Some(waiter.op.clone()),
                ));
            }
            None => {
                // Host may omit job_id on some replies; treat absent as soft OK
                // when we sent one (Zig sometimes echoes null). Not a hard fault.
            }
        }
    }
    ReplyValidation::Ok
}

/// One bounded diagnostic sample for a request or connection event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcDiagSample {
    pub launch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    /// Queue wait before stdin write began (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_wait_ms: Option<u64>,
    /// Duration of the blocking stdin write (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_duration_ms: Option<u64>,
    /// Time from write complete to reply (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_wait_ms: Option<u64>,
    /// Child exit status string when known (connection loss).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_exit: Option<String>,
    /// Short outcome label (ok | timeout | connection_loss | …).
    pub outcome: String,
}

#[derive(Debug, Default)]
pub struct DiagRing {
    samples: VecDeque<IpcDiagSample>,
}

impl DiagRing {
    pub fn push(&mut self, sample: IpcDiagSample) {
        if self.samples.len() >= DIAG_RING_CAP {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
    }

    pub fn snapshot(&self) -> Vec<IpcDiagSample> {
        self.samples.iter().cloned().collect()
    }

    pub fn last(&self) -> Option<&IpcDiagSample> {
        self.samples.back()
    }
}

/// Thread-safe ring wrapper used on `SessionIo`.
#[derive(Debug, Default)]
pub struct SharedDiagRing {
    inner: Mutex<DiagRing>,
}

impl SharedDiagRing {
    pub fn record(&self, sample: IpcDiagSample) {
        match self.inner.lock() {
            Ok(mut g) => g.push(sample),
            Err(poisoned) => poisoned.into_inner().push(sample),
        }
    }

    pub fn snapshot(&self) -> Vec<IpcDiagSample> {
        self.inner
            .lock()
            .map(|g| g.snapshot())
            .unwrap_or_else(|p| p.into_inner().snapshot())
    }
}

pub fn duration_ms(d: Duration) -> u64 {
    d.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_rejects_wrong_protocol() {
        let reply = json!({
            "v": 1,
            "kind": "reply",
            "request_id": "r1",
            "op": "status",
            "ok": true,
            "body": null
        });
        let waiter = PendingWaiter {
            tx: oneshot::channel().0,
            op: "status".into(),
            job_id: None,
            admitted_at: Instant::now(),
            wrote_at: None,
        };
        match validate_reply(&reply, Some(&waiter), "r1") {
            ReplyValidation::Reject(IpcError::ProtocolFailure { message, .. }) => {
                assert!(message.contains("protocol 1"));
            }
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_op_mismatch() {
        let reply = json!({
            "v": 2,
            "kind": "reply",
            "request_id": "r1",
            "op": "node",
            "ok": true,
            "body": null
        });
        let waiter = PendingWaiter {
            tx: oneshot::channel().0,
            op: "status".into(),
            job_id: None,
            admitted_at: Instant::now(),
            wrote_at: None,
        };
        match validate_reply(&reply, Some(&waiter), "r1") {
            ReplyValidation::Reject(IpcError::ProtocolFailure { message, .. }) => {
                assert!(message.contains("op mismatch"));
            }
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_job_id_mismatch() {
        let reply = json!({
            "v": 2,
            "kind": "reply",
            "request_id": "r1",
            "job_id": "j-other",
            "op": "cancel",
            "ok": true,
            "body": null
        });
        let waiter = PendingWaiter {
            tx: oneshot::channel().0,
            op: "cancel".into(),
            job_id: Some("j-accept".into()),
            admitted_at: Instant::now(),
            wrote_at: None,
        };
        match validate_reply(&reply, Some(&waiter), "r1") {
            ReplyValidation::Reject(IpcError::ProtocolFailure { message, .. }) => {
                assert!(message.contains("job_id mismatch"));
            }
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn orphan_reply_is_ignored() {
        let reply = json!({
            "v": 2,
            "kind": "reply",
            "request_id": "r-late",
            "op": "values",
            "ok": true,
            "body": null
        });
        assert!(matches!(
            validate_reply(&reply, None, "r-late"),
            ReplyValidation::Ignore("orphan")
        ));
    }

    #[test]
    fn connection_loss_display_includes_launch() {
        let err = IpcError::connection_loss("pipe closed", "zig-abc", Some("exit 1".into()));
        let s = err.to_string();
        assert!(s.contains("connection_loss"));
        assert!(s.contains("zig-abc"));
        assert!(s.contains("exit 1"));
        assert!(err.is_connection_loss());
    }

    #[test]
    fn status_timeout_is_degraded_not_loss() {
        let err = IpcError::from_transport_message(
            "solver-engine IPC read timed out",
            "launch-1",
            "status",
        );
        match err {
            IpcError::Timeout { degraded, .. } => assert!(degraded),
            other => panic!("expected timeout, got {other:?}"),
        }
        assert!(!err.is_connection_loss());
    }

    #[test]
    fn diag_ring_bounds() {
        let mut ring = DiagRing::default();
        for i in 0..(DIAG_RING_CAP + 10) {
            ring.push(IpcDiagSample {
                launch_id: "L".into(),
                request_id: Some(format!("r{i}")),
                op: Some("status".into()),
                queue_wait_ms: Some(1),
                write_duration_ms: Some(1),
                reply_wait_ms: Some(1),
                child_exit: None,
                outcome: "ok".into(),
            });
        }
        assert_eq!(ring.snapshot().len(), DIAG_RING_CAP);
        let expected = format!("r{}", DIAG_RING_CAP + 9);
        assert_eq!(
            ring.last().and_then(|s| s.request_id.as_deref()),
            Some(expected.as_str())
        );
    }

    #[test]
    fn envelope_serde_round_trip() {
        let req = IpcRequestEnvelope {
            v: PROTOCOL,
            kind: IpcFrameKind::Request,
            request_id: "r1".into(),
            job_id: Some("j1".into()),
            op: "status".into(),
            body: Value::Null,
        };
        let bytes = serde_json::to_vec(&req).unwrap();
        let back: IpcRequestEnvelope = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.op, "status");
        assert_eq!(back.job_id.as_deref(), Some("j1"));
    }
}
