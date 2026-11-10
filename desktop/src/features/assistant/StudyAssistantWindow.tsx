import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  createOpenAiUnifiedChatClient,
  type UnifiedChatClient,
  type UnifiedChatOutcome,
} from "../../domain/assistant/unifiedChat";
import {
  buildAssistantContextSnapshot,
  catalogueProfileMetas,
  chatContentFromReceipt,
  formatContextIndicator,
  renderPendingSetupReview,
  setupResultHasApplyablePatch,
  setupResultIsBroad,
  summarizeContextSnapshot,
  type StudyEvidenceHost,
  type StudyEvidenceLiveState,
} from "../../domain/assistant";
import { AssistantProviderError } from "../../domain/assistant/provider";
import {
  emptyStudySetupPreferences,
  loadStudySetupPreferences,
  type SetupDraftResult,
  type StudySetupPreferences,
} from "../../domain/setup";
import { engineClient } from "../../engine/client";
import {
  clearAssistantOpenAiCredential,
  describeCredentialSource,
  getAssistantOpenAiCredential,
  hasAssistantOpenAiCredential,
  setAssistantOpenAiCredential,
  type CredentialSource,
} from "../../platform/credentials";
import {
  HELP_CHAT_MIN_HEIGHT,
  HELP_CHAT_MIN_WIDTH,
  useHelpChatStore,
} from "../../state/assistantWindowStore";
import { useStudyStore } from "../../state/studyStore";
import { commitAssistantSetup } from "../../domain/assistant/commitAssistantSetup";

interface ChatLine {
  role: "user" | "assistant";
  content: string;
  /** When set, this assistant line carries an applyable setup run. */
  setupRunId?: number;
}

function readPrefs(): StudySetupPreferences {
  try {
    if (typeof localStorage === "undefined") {
      return emptyStudySetupPreferences();
    }
    return loadStudySetupPreferences(localStorage);
  } catch {
    return emptyStudySetupPreferences();
  }
}

export function StudyAssistantWindow() {
  const layout = useHelpChatStore((s) => s.layout);
  const setVisible = useHelpChatStore((s) => s.setVisible);
  const setPosition = useHelpChatStore((s) => s.setPosition);
  const setSize = useHelpChatStore((s) => s.setSize);

  const draft = useStudyStore((s) => s.draft);
  const draftRevision = useStudyStore((s) => s.draftRevision);
  const setupMeta = useStudyStore((s) => s.setupMeta);
  const solutionId = useStudyStore((s) => s.solutionId);
  const status = useStudyStore((s) => s.status);
  const phase = useStudyStore((s) => s.phase);
  const currentNode = useStudyStore((s) => s.currentNode);
  const pathTrail = useStudyStore((s) => s.pathTrail);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const equity = useStudyStore((s) => s.equity);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const applySetupDraft = useStudyStore((s) => s.applySetupDraft);
  const undoSetupTransaction = useStudyStore((s) => s.undoSetupTransaction);
  const canUndoSetup = useStudyStore((s) => s.canUndoSetup);
  const getSetupCatalogue = useStudyStore((s) => s.getSetupCatalogue);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);

  const rangeSourceLabel =
    setupMeta?.summary
      ?.find((line) => /Range-source environment:/i.test(line))
      ?.match(/Range-source environment:\s*([^(]+)/i)?.[1]
      ?.trim() ?? null;

  const contextSnapshot = buildAssistantContextSnapshot({
    draft,
    draftRevision,
    rangeSourceLabel,
    solutionId,
    status,
    phase,
    currentNode,
    pathTrail,
    nodeValues,
    equity: (equity ?? null) as StudyEvidenceLiveState["equity"],
    selectedCell,
    evDisplayBasis,
  });
  const contextIndicator = formatContextIndicator(contextSnapshot);

  function evidenceHost(): StudyEvidenceHost {
    return {
      read: (): StudyEvidenceLiveState => {
        const state = useStudyStore.getState();
        return {
          solutionId: state.solutionId,
          currentNode: state.currentNode,
          nodeValues: state.nodeValues,
          equity: (state.equity ?? null) as StudyEvidenceLiveState["equity"],
          pathTrail: state.pathTrail,
          selectedCell: state.selectedCell,
          evDisplayBasis: state.evDisplayBasis,
          status: state.status,
        };
      },
      ensureNodeAnalysis: async () => {
        await useStudyStore.getState().ensureNodeAnalysis();
      },
      navigateTo: async (nodeId: string) => {
        // Behind-the-scenes: do not push Back/Forward history for assistant hops.
        await useStudyStore.getState().navigateTo(nodeId, { history: "none" });
      },
      fetchNode: async (nodeId: string) => {
        const sid = useStudyStore.getState().solutionId;
        if (!sid) {
          throw new Error("No published solution");
        }
        return engineClient.getNode(sid, nodeId);
      },
    };
  }

  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credSource, setCredSource] = useState<CredentialSource>("none");
  const [credPresent, setCredPresent] = useState(false);
  const [credDraft, setCredDraft] = useState("");
  /** Broad setups wait for an explicit Apply (scalar edits auto-commit). */
  const [pendingSetup, setPendingSetup] = useState<{
    runId: number;
    result: SetupDraftResult;
  } | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{
    kind: "move" | "resize";
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  async function refreshCredentialState() {
    const present = await hasAssistantOpenAiCredential();
    setCredPresent(present);
    if (!present) {
      setCredSource("none");
      return;
    }
    const lookup = await getAssistantOpenAiCredential();
    setCredSource(lookup.source);
  }

  useEffect(() => {
    void refreshCredentialState();
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!layout.visible) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, layout.visible, busy]);

  function makeClient(): UnifiedChatClient {
    return createOpenAiUnifiedChatClient({
      getCredential: async () => {
        const lookup = await getAssistantOpenAiCredential();
        return lookup.value;
      },
    });
  }

  function outcomeToLine(outcome: UnifiedChatOutcome): ChatLine {
    if (outcome.kind === "answer") {
      return { role: "assistant", content: outcome.message };
    }
    return {
      role: "assistant",
      content: outcome.message,
      setupRunId: outcome.run?.runId,
    };
  }

  function commitPending(result: SetupDraftResult, force = false): ChatLine | null {
    const applied = commitAssistantSetup(result, applySetupDraft, { force });
    if (!applied.ok) {
      setError(applied.message);
      return null;
    }
    setPendingSetup(null);
    setWorkspace("build");
    setError(null);
    return {
      role: "assistant",
      content: chatContentFromReceipt(applied.receipt),
    };
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy || !credPresent) return;

    setBusy(true);
    setError(null);
    setPendingSetup(null);
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setDraftText("");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const catalogue = getSetupCatalogue();
      const client = makeClient();
      // Freeze snapshot for this request (same revision as draftRevision).
      const requestSnapshot = contextSnapshot;
      const outcome = await client.turn(
        {
          text: question,
          history,
          setupSummary: summarizeContextSnapshot(requestSnapshot),
          preferencesSummary: "prefs from holdem-study-setup-prefs",
          availableProfiles: catalogueProfileMetas(catalogue),
          draftRevision,
          contextSnapshot: requestSnapshot,
          signal: controller.signal,
        },
        {
          catalogue,
          getDraft: () => useStudyStore.getState().draft,
          getRevision: () => useStudyStore.getState().draftRevision,
          preferences: readPrefs(),
          evidenceHost: evidenceHost(),
        },
      );
      let line = outcomeToLine(outcome);
      if (outcome.kind === "setup" && outcome.run) {
        if (outcome.run.status === "stale") {
          // draftRevision was captured at send-time; do not remint or force-apply.
          setError(
            outcome.run.message ??
              "Setup changed while the assistant ran — regenerate the proposal",
          );
        } else if (outcome.run.status === "draft" && outcome.run.result) {
          const result = outcome.run.result;
          if (!setupResultHasApplyablePatch(result)) {
            line = {
              ...line,
              content:
                `${line.content}\n\nNothing was written to Build — the proposal had no field changes to apply.`,
            };
          } else {
            // Auto-commit scalar and broad setups. A pending Apply control is only
            // for blocked/conflicted commits — waiting for confirmation on every
            // create felt like "nothing happened" when Apply sat below the fold.
            const committed = commitPending(result);
            if (committed) {
              line = committed;
            } else if (setupResultHasApplyablePatch(result)) {
              setPendingSetup({ runId: outcome.run.runId, result });
              line = {
                ...line,
                content: `Action needed — Apply to Build below.\n\n${line.content}\n\n${renderPendingSetupReview(result)}`,
                setupRunId: outcome.run.runId,
              };
            }
          }
        }
      }
      setMessages((prev) => [...prev, line]);
    } catch (err) {
      if (controller.signal.aborted) {
        setError("Cancelled");
      } else if (err instanceof AssistantProviderError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function onTitlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, select, input, textarea, a")) return;
    event.preventDefault();
    dragRef.current = {
      kind: "move",
      startX: event.clientX,
      startY: event.clientY,
      origX: layout.x,
      origY: layout.y,
      origW: layout.width,
      origH: layout.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      kind: "resize",
      startX: event.clientX,
      startY: event.clientY,
      origX: layout.x,
      origY: layout.y,
      origW: layout.width,
      origH: layout.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPanelPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === "move") {
      setPosition(drag.origX + dx, drag.origY + dy);
    } else {
      setSize(
        Math.max(HELP_CHAT_MIN_WIDTH, drag.origW + dx),
        Math.max(HELP_CHAT_MIN_HEIGHT, drag.origH + dy),
      );
    }
  }

  function onPanelPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  if (!layout.visible) {
    return null;
  }

  return (
    <div
      className="help-chat-window"
      role="dialog"
      aria-label="Study assistant"
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
      onPointerMove={onPanelPointerMove}
      onPointerUp={onPanelPointerUp}
      onPointerCancel={onPanelPointerUp}
    >
      <div className="help-chat-window__title" onPointerDown={onTitlePointerDown}>
        <div className="help-chat-window__title-text">
          <strong>Study assistant</strong>
          <span
            className="assistant-ready-pill"
            data-ready={credPresent ? "true" : "false"}
            title={credPresent ? describeCredentialSource(credSource) : undefined}
          >
            {credPresent ? "OpenAI ready" : "Not connected"}
          </span>
          <span
            className="help-chat-window__context"
            title={contextSnapshot.absences.join("\n") || contextIndicator}
            data-testid="assistant-context-indicator"
          >
            {contextIndicator}
          </span>
        </div>
        <div className="help-chat-window__title-actions">
          <button
            type="button"
            className="icon-btn"
            title="Hide study assistant"
            aria-label="Hide study assistant"
            onClick={() => setVisible(false)}
          >
            Hide
          </button>
        </div>
      </div>

      <div className="help-chat-window__body">
        {!credPresent ? (
          <div className="help-chat-window__creds">
            <p className="muted">
              Connect an OpenAI API key to use the study assistant.
            </p>
            <div className="assistant-compose-actions">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="OpenAI API key"
                value={credDraft}
                disabled={busy}
                onChange={(event) => setCredDraft(event.target.value)}
                aria-label="OpenAI API key"
              />
              <button
                type="button"
                className="toolbar-btn"
                disabled={busy || !credDraft.trim()}
                onClick={() => {
                  void (async () => {
                    try {
                      const source = await setAssistantOpenAiCredential(credDraft);
                      setCredDraft("");
                      setCredPresent(true);
                      setCredSource(source);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  })();
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="assistant-compose-actions">
            <button
              type="button"
              className="toolbar-btn danger"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  await clearAssistantOpenAiCredential();
                  setCredPresent(false);
                  setCredSource("none");
                })();
              }}
            >
              Clear key
            </button>
          </div>
        )}

        <div className="help-chat-window__transcript" ref={transcriptRef}>
          {messages.length === 0 ? null : (
            messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`help-chat-bubble help-chat-bubble--${message.role}`}
              >
                <div className="help-chat-bubble__role">
                  {message.role === "user" ? "You" : "Assistant"}
                </div>
                <div className="help-chat-bubble__text">{message.content}</div>
              </div>
            ))
          )}
          {busy ? <p className="muted">Working…</p> : null}
        </div>

        {error ? <p className="assistant-status warn">{error}</p> : null}

        {pendingSetup ? (
          <div
            className="help-chat-window__pending-apply"
            data-testid="assistant-pending-apply"
            role="status"
            aria-live="polite"
          >
            <p className="help-chat-window__pending-apply-label">
              Setup ready — apply it to Build, or dismiss.
              {setupResultIsBroad(pendingSetup.result)
                ? " This replaces multiple fields."
                : null}
            </p>
            <div className="assistant-compose-actions">
              <button
                type="button"
                className="toolbar-btn primary"
                disabled={busy}
                onClick={() => {
                  const committed = commitPending(pendingSetup.result);
                  if (committed) {
                    setMessages((prev) => [...prev, committed]);
                  }
                }}
              >
                Apply to Build
              </button>
              {pendingSetup.result.conflicts.length > 0 ? (
                <button
                  type="button"
                  className="toolbar-btn"
                  disabled={busy}
                  onClick={() => {
                    const committed = commitPending(pendingSetup.result, true);
                    if (committed) {
                      setMessages((prev) => [...prev, committed]);
                    }
                  }}
                >
                  Apply anyway
                </button>
              ) : null}
              <button
                type="button"
                className="toolbar-btn"
                disabled={busy}
                onClick={() => {
                  setPendingSetup(null);
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content: "Discarded the pending setup proposal.",
                    },
                  ]);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {canUndoSetup ? (
          <div className="assistant-compose-actions">
            <button
              type="button"
              className="toolbar-btn"
              disabled={busy}
              onClick={() => {
                const outcome = undoSetupTransaction();
                const content =
                  outcome.ok && outcome.message
                    ? outcome.message
                    : "Reverted the last assistant change.";
                setMessages((prev) => [...prev, { role: "assistant", content }]);
              }}
            >
              Undo
            </button>
          </div>
        ) : null}

        <div className="help-chat-window__compose">
          <textarea
            rows={2}
            value={draftText}
            placeholder="Ask anything, or e.g. Set up CO vs BB SRP with 100NL ranges"
            disabled={busy || !credPresent}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send(draftText);
              }
            }}
          />
          <div className="assistant-compose-actions">
            <button
              type="button"
              className="toolbar-btn primary"
              disabled={busy || !credPresent || !draftText.trim()}
              onClick={() => void send(draftText)}
            >
              {busy ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              disabled={!busy}
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="toolbar-btn"
              disabled={busy || messages.length === 0}
              onClick={() => {
                setMessages([]);
                setError(null);
              }}
            >
              Clear chat
            </button>
          </div>
        </div>
      </div>

      <div
        className="help-chat-window__resize"
        onPointerDown={onResizePointerDown}
        title="Resize"
        aria-label="Resize study assistant"
        role="separator"
      />
    </div>
  );
}
