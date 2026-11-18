// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Bounded write admission for the solver-engine connection supervisor (PR2).
//!
//! - Cap outstanding requests by count and queued stdin bytes.
//! - Reserve slots for Stop/Pause (`cancel` / `pause`).
//! - Prefer control frames between writes.
//! - Coalesce concurrent `status` polls onto one in-flight request per launch
//!   with **atomic** leader election + follower settlement.
//! - Deadlines start at admission; classify expired-before-write vs
//!   unknown-after-write (mutations must not auto-replay).
//! - Explicit delivery states: Queued → Writing → Written (or Cancelled while
//!   still queued so an expired request never reaches the sidecar).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::oneshot;

/// Soft cap on admitted-but-unsettled requests (queued + written + awaiting reply).
pub const MAX_OUTSTANDING: usize = 24;
/// Cap on bytes sitting in the writer queues (not yet written).
pub const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;
/// Slots held back for Stop/Pause so analysis floods cannot starve control.
pub const CONTROL_RESERVE_SLOTS: usize = 2;
/// Warn when a control frame waited this long behind an in-flight write.
pub const CONTROL_BEHIND_WRITE_WARN: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpClass {
    /// `cancel` / `pause` — reserved capacity + write priority.
    Control,
    /// Coalesced per launch onto one in-flight poll.
    Status,
    /// Session / job mutations — unknown if lost after write starts.
    Mutating,
    Normal,
}

pub fn classify_op(op: &str) -> OpClass {
    match op {
        "cancel" | "pause" => OpClass::Control,
        "status" => OpClass::Status,
        // Audit §4: lock/edit + equity-job creation mutate session state too.
        "save"
        | "open"
        | "solve"
        | "resolve_locked"
        | "begin_config"
        | "put_lock"
        | "delete_lock"
        | "put_strategy_edit"
        | "delete_strategy_edit"
        | "start_equity_job"
        | "cancel_equity_job" => OpClass::Mutating,
        _ => OpClass::Normal,
    }
}

pub fn is_mutating(op: &str) -> bool {
    matches!(classify_op(op), OpClass::Mutating)
}

/// Stdin delivery lifecycle owned by the writer thread (sole frame-order owner).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DeliveryState {
    /// Framed and admitted; not yet handed to `write_all`.
    Queued = 0,
    /// Writer has started (or is about to start) the blocking pipe write.
    Writing = 1,
    /// `write_all` + flush completed successfully.
    Written = 2,
    /// Expired / abandoned while still queued — must never reach the sidecar.
    Cancelled = 3,
}

impl DeliveryState {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Queued,
            1 => Self::Writing,
            2 => Self::Written,
            _ => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Priority {
    Control,
    Normal,
}

struct QueuedWrite {
    frame: Vec<u8>,
    priority: Priority,
    op: String,
    admitted_at: Instant,
    deadline: Instant,
    /// True when a stdin write was already in flight at enqueue time.
    enqueued_behind_write: bool,
    delivery: Arc<AtomicU8>,
    done: oneshot::Sender<Result<WriteComplete, String>>,
}

#[derive(Debug)]
pub struct WriteComplete {
    pub queue_wait: Duration,
    pub write_duration: Duration,
    #[allow(dead_code)]
    pub behind_inflight_write: bool,
    pub delivery: DeliveryState,
}

/// Handle returned from enqueue: await write completion and/or cancel if still queued.
pub struct WriteTicket {
    pub done_rx: oneshot::Receiver<Result<WriteComplete, String>>,
    /// Shared with the writer; clone before awaiting `done_rx` so cancel stays usable.
    pub delivery: Arc<AtomicU8>,
}

impl WriteTicket {
    pub fn state(&self) -> DeliveryState {
        DeliveryState::from_u8(self.delivery.load(Ordering::SeqCst))
    }

    /// Cancel delivery if still queued. Returns true when the frame will never
    /// be written (safe "never sent" / expired-before-write).
    pub fn try_cancel_if_queued(&self) -> bool {
        Self::cancel_if_queued(&self.delivery)
    }

    pub fn cancel_if_queued(delivery: &AtomicU8) -> bool {
        delivery
            .compare_exchange(
                DeliveryState::Queued as u8,
                DeliveryState::Cancelled as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    pub fn state_of(delivery: &AtomicU8) -> DeliveryState {
        DeliveryState::from_u8(delivery.load(Ordering::SeqCst))
    }
}

struct BoardInner {
    control: VecDeque<QueuedWrite>,
    normal: VecDeque<QueuedWrite>,
    queued_bytes: usize,
    write_inflight: bool,
}

/// Shared admission + priority write board for one launch.
pub struct AdmissionBoard {
    inner: Mutex<BoardInner>,
    wake: Condvar,
    outstanding: AtomicUsize,
    shut_down: Arc<AtomicBool>,
    /// Last observed control wait behind an in-flight write (nanoseconds).
    pub last_control_behind_write_ns: AtomicU64,
    /// Coalesce waiters for the in-flight status request (same launch).
    status_coalesce: Mutex<Option<StatusCoalesce>>,
}

struct StatusCoalesce {
    /// Empty until the leader binds its `request_id`.
    request_id: String,
    bound: bool,
    waiters: Vec<oneshot::Sender<Result<Value, String>>>,
}

/// Result of atomic status leader election / follower join.
pub enum StatusRole {
    /// Another request already leads; settle via this receiver (never maps a
    /// local drop to process exit — leader must settle every exit path).
    Follower(oneshot::Receiver<Result<Value, String>>),
    /// This caller owns the sole in-flight status for the launch.
    Leader,
}

impl AdmissionBoard {
    pub fn new(shut_down: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(BoardInner {
                control: VecDeque::new(),
                normal: VecDeque::new(),
                queued_bytes: 0,
                write_inflight: false,
            }),
            wake: Condvar::new(),
            outstanding: AtomicUsize::new(0),
            shut_down,
            last_control_behind_write_ns: AtomicU64::new(0),
            status_coalesce: Mutex::new(None),
        })
    }

    pub fn release_outstanding(&self) {
        let _ = self.outstanding.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            Some(n.saturating_sub(1))
        });
    }

    /// Atomically join an in-flight status or claim leadership.
    ///
    /// Checking for an existing leader and installing a new one must not race
    /// across separate lock acquisitions (audit §3: local dropped waiter ≠ exit).
    pub fn elect_status_role(&self) -> StatusRole {
        let mut slot = match self.status_coalesce.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(coalesce) = slot.as_mut() {
            let (tx, rx) = oneshot::channel();
            coalesce.waiters.push(tx);
            return StatusRole::Follower(rx);
        }
        *slot = Some(StatusCoalesce {
            request_id: String::new(),
            bound: false,
            waiters: Vec::new(),
        });
        StatusRole::Leader
    }

    /// Bind the leader's `request_id` after allocation (still under coalesce ownership).
    pub fn bind_status_leader(&self, request_id: &str) {
        if let Ok(mut slot) = self.status_coalesce.lock() {
            if let Some(c) = slot.as_mut() {
                c.request_id = request_id.to_string();
                c.bound = true;
            }
        }
    }

    /// Abandon leadership before bind (encode/reserve failure). Settles followers.
    pub fn abandon_status_leader(&self, err: impl Into<String>) {
        let err = err.into();
        let waiters = {
            let mut slot = match self.status_coalesce.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match slot.take() {
                Some(c) if !c.bound => c.waiters,
                Some(other) => {
                    // Already bound to a live request — leave it.
                    *slot = Some(other);
                    Vec::new()
                }
                None => Vec::new(),
            }
        };
        settle_status_waiters(waiters, Err(err));
    }

    /// Take and return waiters for a bound request id (leader settlement).
    pub fn take_status_coalesce(
        &self,
        request_id: &str,
    ) -> Vec<oneshot::Sender<Result<Value, String>>> {
        let mut slot = match self.status_coalesce.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match slot.take() {
            Some(c) if c.bound && c.request_id == request_id => c.waiters,
            Some(c) if !c.bound && c.request_id.is_empty() => {
                // Unbound leader slot for this election — treat as ours when
                // request_id is being bound atomically with take (rare).
                if request_id.is_empty() {
                    c.waiters
                } else {
                    *slot = Some(c);
                    Vec::new()
                }
            }
            Some(other) => {
                *slot = Some(other);
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// Settle every status waiter with a typed transport message (shutdown / kill).
    pub fn clear_status_coalesce(&self) {
        self.settle_all_status(Err("solver-engine session killed".into()));
    }

    pub fn settle_all_status(&self, result: Result<Value, String>) {
        let waiters = {
            let mut slot = match self.status_coalesce.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match slot.take() {
                Some(c) => c.waiters,
                None => Vec::new(),
            }
        };
        settle_status_waiters(waiters, result);
    }

    /// Reserve an outstanding slot (count) before enqueueing a frame.
    pub fn try_reserve_slot(&self, class: OpClass) -> Result<(), String> {
        loop {
            let current = self.outstanding.load(Ordering::SeqCst);
            if current >= MAX_OUTSTANDING {
                return Err(format!(
                    "admission saturated: {current}/{MAX_OUTSTANDING} outstanding requests"
                ));
            }
            if class != OpClass::Control {
                let free = MAX_OUTSTANDING - current;
                if free <= CONTROL_RESERVE_SLOTS {
                    return Err(format!(
                        "admission saturated: control reserve ({CONTROL_RESERVE_SLOTS} slots) held for Stop/Pause \
                         ({current}/{MAX_OUTSTANDING} outstanding)"
                    ));
                }
            }
            match self.outstanding.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Ok(()),
                Err(_) => continue,
            }
        }
    }

    /// Enqueue a framed write. Caller must already hold an outstanding reservation.
    pub fn enqueue_write(
        &self,
        op: &str,
        frame: Vec<u8>,
        admitted_at: Instant,
        deadline: Instant,
    ) -> Result<WriteTicket, String> {
        let class = classify_op(op);
        let priority = match class {
            OpClass::Control => Priority::Control,
            _ => Priority::Normal,
        };
        let frame_len = frame.len();
        let (done_tx, done_rx) = oneshot::channel();
        let delivery = Arc::new(AtomicU8::new(DeliveryState::Queued as u8));

        let mut board = self
            .inner
            .lock()
            .map_err(|_| "solver-engine admission lock poisoned".to_string())?;

        let bytes_full = board.queued_bytes.saturating_add(frame_len) > MAX_QUEUED_BYTES;
        if bytes_full && class != OpClass::Control {
            return Err(format!(
                "admission saturated: queued bytes {}+{frame_len} exceed {MAX_QUEUED_BYTES}",
                board.queued_bytes
            ));
        }
        // Control may still enqueue a small cancel/pause when the byte budget is full.
        if bytes_full && class == OpClass::Control && frame_len > 64 * 1024 {
            return Err("admission saturated: control frame too large under byte cap".into());
        }

        let enqueued_behind_write = board.write_inflight;
        let item = QueuedWrite {
            frame,
            priority,
            op: op.to_string(),
            admitted_at,
            deadline,
            enqueued_behind_write,
            delivery: Arc::clone(&delivery),
            done: done_tx,
        };
        board.queued_bytes = board.queued_bytes.saturating_add(frame_len);
        match priority {
            Priority::Control => board.control.push_back(item),
            Priority::Normal => board.normal.push_back(item),
        }
        self.wake.notify_one();
        Ok(WriteTicket { done_rx, delivery })
    }

    fn pop_next(board: &mut BoardInner) -> Option<QueuedWrite> {
        // Skip frames cancelled while queued (expired without delivery).
        loop {
            let next = if let Some(q) = board.control.pop_front() {
                Some(q)
            } else if let Some(q) = board.normal.pop_front() {
                Some(q)
            } else {
                None
            };
            let Some(q) = next else {
                return None;
            };
            board.queued_bytes = board.queued_bytes.saturating_sub(q.frame.len());
            if q.delivery.load(Ordering::SeqCst) == DeliveryState::Cancelled as u8 {
                // RPC already settled; drop without writing or signaling.
                continue;
            }
            return Some(q);
        }
    }

    pub fn signal_shutdown(&self) {
        self.wake.notify_all();
    }
}

fn settle_status_waiters(
    waiters: Vec<oneshot::Sender<Result<Value, String>>>,
    result: Result<Value, String>,
) {
    for w in waiters {
        let _ = w.send(result.clone());
    }
}

/// Spawn the dedicated stdin writer that drains the admission board (control first).
///
/// The writer is the sole owner of frame order. The kill handle stays independent
/// of this thread so a stuck `write_all` can still be interrupted by reaping the child.
pub fn spawn_writer(
    mut stdin: std::process::ChildStdin,
    board: Arc<AdmissionBoard>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("solver-engine-stdin".into())
        .spawn(move || {
            loop {
                if board.shut_down.load(Ordering::SeqCst) {
                    // Drain: fail anything still queued (not cancelled).
                    if let Ok(mut inner) = board.inner.lock() {
                        while let Some(q) = AdmissionBoard::pop_next(&mut inner) {
                            let _ = q.done.send(Err("solver-engine session shut down".into()));
                        }
                        inner.write_inflight = false;
                    }
                    break;
                }

                let next = {
                    let mut inner = match board.inner.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    loop {
                        if let Some(q) = AdmissionBoard::pop_next(&mut inner) {
                            inner.write_inflight = true;
                            break Some(q);
                        }
                        if board.shut_down.load(Ordering::SeqCst) {
                            break None;
                        }
                        match board.wake.wait_timeout(inner, Duration::from_millis(50)) {
                            Ok((guard, _)) => {
                                inner = guard;
                            }
                            Err(poisoned) => {
                                let (guard, _) = poisoned.into_inner();
                                inner = guard;
                            }
                        }
                        if board.shut_down.load(Ordering::SeqCst) {
                            break None;
                        }
                    }
                };

                let Some(q) = next else {
                    continue;
                };

                // Cancelled while waiting on the condvar path, or deadline elapsed
                // while still queued — never start the pipe write.
                let cancelled = q.delivery.load(Ordering::SeqCst) == DeliveryState::Cancelled as u8;
                let expired = Instant::now() >= q.deadline;
                if cancelled || expired {
                    if expired && !cancelled {
                        let _ = q.delivery.compare_exchange(
                            DeliveryState::Queued as u8,
                            DeliveryState::Cancelled as u8,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        );
                    }
                    if let Ok(mut inner) = board.inner.lock() {
                        inner.write_inflight = false;
                    }
                    board.wake.notify_one();
                    if cancelled {
                        // RPC already reported expired-before-write.
                        let _ = q.done.send(Err(format!(
                            "expired-before-write: op {} cancelled while queued (never reached sidecar)",
                            q.op
                        )));
                    } else {
                        let _ = q.done.send(Err(format!(
                            "expired-before-write: op {} deadline elapsed while queued (never reached sidecar)",
                            q.op
                        )));
                    }
                    continue;
                }

                // Transition Queued → Writing. If a concurrent cancel won, skip.
                if q
                    .delivery
                    .compare_exchange(
                        DeliveryState::Queued as u8,
                        DeliveryState::Writing as u8,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_err()
                {
                    if let Ok(mut inner) = board.inner.lock() {
                        inner.write_inflight = false;
                    }
                    board.wake.notify_one();
                    let _ = q.done.send(Err(format!(
                        "expired-before-write: op {} cancelled while queued (never reached sidecar)",
                        q.op
                    )));
                    continue;
                }

                let started = Instant::now();
                let queue_wait = started.saturating_duration_since(q.admitted_at);
                if q.priority == Priority::Control && q.enqueued_behind_write {
                    board
                        .last_control_behind_write_ns
                        .store(queue_wait.as_nanos() as u64, Ordering::SeqCst);
                    if queue_wait >= CONTROL_BEHIND_WRITE_WARN {
                        eprintln!(
                            "info: control op {} waited {queue_wait:?} behind in-flight stdin write",
                            q.op
                        );
                    }
                }

                let write_started = Instant::now();
                let write_result = stdin
                    .write_all(&q.frame)
                    .and_then(|_| stdin.flush())
                    .map_err(|err| format!("solver-engine write: {err}"));
                let write_duration = write_started.elapsed();

                if let Ok(mut inner) = board.inner.lock() {
                    inner.write_inflight = false;
                }
                board.wake.notify_one();

                match write_result {
                    Ok(()) => {
                        q.delivery
                            .store(DeliveryState::Written as u8, Ordering::SeqCst);
                        let _ = q.done.send(Ok(WriteComplete {
                            queue_wait,
                            write_duration,
                            behind_inflight_write: q.enqueued_behind_write,
                            delivery: DeliveryState::Written,
                        }));
                    }
                    Err(err) => {
                        // Signal shutdown so the reader/session can fail waiters once.
                        board.shut_down.store(true, Ordering::SeqCst);
                        board.signal_shutdown();
                        let _ = q.done.send(Err(err));
                    }
                }
            }
        })
        .map_err(|err| format!("spawn solver-engine writer: {err}"))
}

/// Test helper: push N dummy outstanding reservations (no frames).
#[cfg(test)]
pub fn force_outstanding_for_test(board: &AdmissionBoard, n: usize) {
    board.outstanding.store(n, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_ops() {
        assert_eq!(classify_op("cancel"), OpClass::Control);
        assert_eq!(classify_op("pause"), OpClass::Control);
        assert_eq!(classify_op("status"), OpClass::Status);
        assert_eq!(classify_op("save"), OpClass::Mutating);
        assert_eq!(classify_op("solve"), OpClass::Mutating);
        assert_eq!(classify_op("put_lock"), OpClass::Mutating);
        assert_eq!(classify_op("put_strategy_edit"), OpClass::Mutating);
        assert_eq!(classify_op("start_equity_job"), OpClass::Mutating);
        assert_eq!(classify_op("values"), OpClass::Normal);
    }

    #[test]
    fn control_reserve_blocks_normal_but_allows_cancel() {
        let board = AdmissionBoard::new(Arc::new(AtomicBool::new(false)));
        force_outstanding_for_test(&board, MAX_OUTSTANDING - CONTROL_RESERVE_SLOTS);
        let err = board.try_reserve_slot(OpClass::Normal).unwrap_err();
        assert!(err.contains("control reserve"), "{err}");
        board
            .try_reserve_slot(OpClass::Control)
            .expect("control may use reserve");
    }

    #[test]
    fn hard_cap_blocks_even_control() {
        let board = AdmissionBoard::new(Arc::new(AtomicBool::new(false)));
        force_outstanding_for_test(&board, MAX_OUTSTANDING);
        let err = board.try_reserve_slot(OpClass::Control).unwrap_err();
        assert!(err.contains("saturated"), "{err}");
    }

    #[test]
    fn status_election_is_atomic_one_leader() {
        let board = AdmissionBoard::new(Arc::new(AtomicBool::new(false)));
        let a = board.elect_status_role();
        let b = board.elect_status_role();
        assert!(matches!(a, StatusRole::Leader));
        assert!(matches!(b, StatusRole::Follower(_)));
        board.bind_status_leader("r-status-1");
        let waiters = board.take_status_coalesce("r-status-1");
        assert_eq!(waiters.len(), 1);
        settle_status_waiters(waiters, Ok(serde_json::json!({"ok": true})));
    }

    #[test]
    fn cancel_while_queued_marks_cancelled() {
        let delivery = Arc::new(AtomicU8::new(DeliveryState::Queued as u8));
        let ticket = WriteTicket {
            done_rx: oneshot::channel().1,
            delivery: Arc::clone(&delivery),
        };
        assert!(ticket.try_cancel_if_queued());
        assert_eq!(ticket.state(), DeliveryState::Cancelled);
        assert!(!ticket.try_cancel_if_queued());
        delivery.store(DeliveryState::Writing as u8, Ordering::SeqCst);
        let ticket2 = WriteTicket {
            done_rx: oneshot::channel().1,
            delivery,
        };
        assert!(!ticket2.try_cancel_if_queued());
        assert_eq!(ticket2.state(), DeliveryState::Writing);
    }
}
