import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  createFakeUnifiedChatClient,
  createOpenAiUnifiedChatClient,
  type UnifiedChatClient,
  type UnifiedChatOutcome,
} from "../../domain/assistant/unifiedChat";
import { catalogueProfileMetas } from "../../domain/assistant";
import { AssistantProviderError } from "../../domain/assistant/provider";
import {
  emptyStudySetupPreferences,
  loadStudySetupPreferences,
  type SetupDraftResult,
  type StudySetupPreferences,
} from "../../domain/setup";
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
} from "../../state/helpChatStore";
import { useStudyStore } from "../../state/studyStore";

type ProviderMode = "fake" | "openai";

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
  const applySetupDraft = useStudyStore((s) => s.applySetupDraft);
  const undoSetupTransaction = useStudyStore((s) => s.undoSetupTransaction);
  const canUndoSetup = useStudyStore((s) => s.canUndoSetup);
  const getSetupCatalogue = useStudyStore((s) => s.getSetupCatalogue);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);

  const [providerMode, setProviderMode] = useState<ProviderMode>("fake");
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credSource, setCredSource] = useState<CredentialSource>("none");
  const [credPresent, setCredPresent] = useState(false);
  const [credDraft, setCredDraft] = useState("");

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
    void (async () => {
      await refreshCredentialState();
      if (await hasAssistantOpenAiCredential()) {
        setProviderMode("openai");
      }
    })();
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
    if (providerMode === "fake") {
      return createFakeUnifiedChatClient();
    }
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

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    setBusy(true);
    setError(null);
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setDraftText("");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const catalogue = getSetupCatalogue();
      const client = makeClient();
      const outcome = await client.turn(
        {
          text: question,
          history,
          setupSummary: `board=${draft.boardText || "(none)"} pot=${draft.pot} stack=${draft.stack} oop=${draft.oopRange.slice(0, 48)} ip=${draft.ipRange.slice(0, 48)} rev=${draftRevision}`,
          preferencesSummary: "prefs from holdem-study-setup-prefs",
          availableProfiles: catalogueProfileMetas(catalogue),
          draftRevision,
          signal: controller.signal,
        },
        {
          catalogue,
          getDraft: () => useStudyStore.getState().draft,
          getRevision: () => useStudyStore.getState().draftRevision,
          preferences: readPrefs(),
        },
      );
      let line = outcomeToLine(outcome);
      if (
        outcome.kind === "setup" &&
        outcome.run?.result &&
        outcome.run.status !== "cancelled" &&
        outcome.run.status !== "error"
      ) {
        const applied = commitSetup(outcome.run.result);
        if (applied.ok) {
          setWorkspace("build");
          line = {
            ...line,
            content: `${line.content}\n\nUpdated the spot.`,
          };
        } else if (applied.reason !== "empty") {
          setError(applied.message);
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

  function commitSetup(result: SetupDraftResult) {
    const write = (requestRevision: number) =>
      applySetupDraft(
        requestRevision === result.requestRevision
          ? result
          : { ...result, requestRevision },
        { force: true },
      );
    const first = write(result.requestRevision);
    if (first.ok || first.reason !== "stale") {
      return first;
    }
    return write(useStudyStore.getState().draftRevision);
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
            data-ready={providerMode === "fake" || credPresent ? "true" : "false"}
            title={
              providerMode === "openai" && credPresent
                ? describeCredentialSource(credSource)
                : undefined
            }
          >
            {providerMode === "fake"
              ? "Demo ready"
              : credPresent
                ? "OpenAI ready"
                : "Not connected"}
          </span>
        </div>
        <div className="help-chat-window__title-actions">
          <label className="help-chat-window__provider">
            <span className="sr-only">Provider</span>
            <select
              value={providerMode}
              disabled={busy}
              onChange={(event) => setProviderMode(event.target.value as ProviderMode)}
              aria-label="Study assistant provider"
            >
              <option value="fake">Demo</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
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
        {providerMode === "openai" && !credPresent ? (
          <div className="help-chat-window__creds">
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
        ) : null}
        {providerMode === "openai" && credPresent ? (
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
        ) : null}

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

        {canUndoSetup ? (
          <div className="assistant-compose-actions">
            <button
              type="button"
              className="toolbar-btn"
              disabled={busy}
              onClick={() => {
                undoSetupTransaction();
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: "Reverted the last assistant change." },
                ]);
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
            disabled={busy}
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
              disabled={busy || !draftText.trim()}
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

/** @deprecated Prefer StudyAssistantWindow — kept name alias for imports mid-refactor. */
export const HelpChatWindow = StudyAssistantWindow;
