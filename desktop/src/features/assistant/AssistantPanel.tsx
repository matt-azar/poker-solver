import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAssistantSession,
  createFakeAssistantProvider,
  createOpenAiAssistantProvider,
  type AssistantRunResult,
  type AssistantProvider,
} from "../../domain/assistant";
import {
  emptyStudySetupPreferences,
  loadStudySetupPreferences,
  type StudySetupPreferences,
} from "../../domain/setup";
import { useStudyStore } from "../../state/studyStore";

type ProviderMode = "fake" | "openai";

const EXAMPLES = [
  "Set up CO vs BB using my 100NL profile",
  "Change the flop to As 7d 2c",
  "Use 33% and 75% flop bets for IP",
  "Duplicate this setup at 150bb",
];

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

function providerLabel(mode: ProviderMode): string {
  return mode === "fake" ? "Demo (fake adapter)" : "OpenAI";
}

export function AssistantPanel() {
  const draft = useStudyStore((s) => s.draft);
  const draftRevision = useStudyStore((s) => s.draftRevision);
  const setupMeta = useStudyStore((s) => s.setupMeta);
  const applySetupDraft = useStudyStore((s) => s.applySetupDraft);
  const undoSetupTransaction = useStudyStore((s) => s.undoSetupTransaction);
  const canUndoSetup = useStudyStore((s) => s.canUndoSetup);
  const getSetupCatalogue = useStudyStore((s) => s.getSetupCatalogue);
  const message = useStudyStore((s) => s.message);

  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const [providerMode, setProviderMode] = useState<ProviderMode>("fake");
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<AssistantRunResult | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [appliedRunId, setAppliedRunId] = useState<number | null>(null);

  const session = useMemo(() => createAssistantSession(), []);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      session.cancel();
      abortRef.current?.abort();
    };
  }, [session]);

  function makeProvider(): AssistantProvider {
    if (providerMode === "fake") {
      return createFakeAssistantProvider();
    }
    return createOpenAiAssistantProvider({
      getCredential: async () => {
        // Browser prototype: optional localStorage key set outside the bundle.
        // Desktop builds should inject via native secure storage later.
        try {
          const key = localStorage.getItem("holdem-study-openai-key");
          return key && key.trim() ? key.trim() : null;
        } catch {
          return null;
        }
      },
    });
  }

  async function runAssistant(requestText: string) {
    const trimmed = requestText.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setStatusNote(null);
    setLastRun(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const catalogue = getSetupCatalogue();
      const prefs = readPrefs();
      const run = await session.run(trimmed, {
        provider: makeProvider(),
        catalogue,
        getDraft: () => useStudyStore.getState().draft,
        getRevision: () => useStudyStore.getState().draftRevision,
        preferences: prefs,
        signal: controller.signal,
        setupSummary: `board=${draft.boardText || "(none)"} pot=${draft.pot} stack=${draft.stack} oop=${draft.oopRange.slice(0, 40)} ip=${draft.ipRange.slice(0, 40)} rev=${draftRevision}`,
      });
      setLastRun(run);
      if (run.status === "error") {
        setStatusNote(run.message ?? run.error?.message ?? "Assistant failed");
      } else if (run.status === "cancelled") {
        setStatusNote("Cancelled");
      } else if (run.status === "stale") {
        setStatusNote("Draft changed during the request — run again");
      }
    } catch (error) {
      setStatusNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function applyLastDraft(force = false) {
    if (!lastRun?.result || appliedRunId === lastRun.runId) {
      return;
    }
    const outcome = applySetupDraft(lastRun.result, { force });
    if (!outcome.ok) {
      setStatusNote(outcome.message);
      return;
    }
    setAppliedRunId(lastRun.runId);
    setStatusNote(force ? "Applied with unresolved conflicts marked in Build" : "Applied to Build");
  }

  const draftResult = lastRun?.result;
  const alreadyApplied = lastRun != null && appliedRunId === lastRun.runId;
  const canApplyProposal =
    lastRun?.status === "draft" &&
    draftResult != null &&
    Object.keys(draftResult.draftPatch).length > 0 &&
    !alreadyApplied;

  return (
    <section className="assistant-panel build-section span-2" aria-label="Study setup assistant">
      <div className="assistant-header">
        <h2>Setup assistant</h2>
        <div className="assistant-header-actions">
          <label className="assistant-provider">
            Provider
            <select
              value={providerMode}
              disabled={busy}
              onChange={(event) => setProviderMode(event.target.value as ProviderMode)}
            >
              <option value="fake">Demo (fake)</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
          <button type="button" className="toolbar-btn" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {open ? (
        <>
          <p className="assistant-lede">
            Describe a study setup. Changes apply through the same Build validation path as manual
            edits. {providerLabel(providerMode)}
            {providerMode === "fake"
              ? " interprets requests locally for demos — not a hosted language model."
              : " sends setup summaries and profile metadata only (not full private ranges)."}
          </p>

          <div className="assistant-examples">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="toolbar-btn"
                disabled={busy}
                onClick={() => {
                  setText(example);
                  void runAssistant(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>

          <div className="assistant-compose">
            <textarea
              rows={2}
              value={text}
              placeholder="e.g. Set up CO vs BB using my 100NL profile"
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void runAssistant(text);
                }
              }}
            />
            <div className="assistant-compose-actions">
              <button
                type="button"
                className="toolbar-btn primary"
                disabled={busy || !text.trim()}
                onClick={() => void runAssistant(text)}
              >
                {busy ? "Working…" : "Prepare"}
              </button>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!busy}
                onClick={() => {
                  session.cancel();
                  abortRef.current?.abort();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!canUndoSetup}
                onClick={undoSetupTransaction}
              >
                Undo setup
              </button>
            </div>
          </div>

          {statusNote ? <p className="assistant-status">{statusNote}</p> : null}
          {busy ? null : message && statusNote !== message ? (
            <p className="assistant-status muted">{message}</p>
          ) : null}

          {draftResult ? (
            <div className="assistant-result">
              <div className="assistant-result-title">
                Proposal
                <span className="tabular"> · rev {draftResult.requestRevision}</span>
                {draftResult.profile ? (
                  <span>
                    {" "}
                    · {draftResult.profile.displayName} ({draftResult.profile.classification})
                  </span>
                ) : null}
              </div>
              <ul>
                {draftResult.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {draftResult.missing.length > 0 ? (
                <div className="assistant-flags">
                  <strong>Missing</strong>
                  <ul>
                    {draftResult.missing.map((item) => (
                      <li key={`${item.field}-${item.reason}`}>{item.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {draftResult.conflicts.length > 0 ? (
                <div className="assistant-flags warn">
                  <strong>Conflicts</strong>
                  <ul>
                    {draftResult.conflicts.map((item) => (
                      <li key={`${item.field}-${item.message}`}>{item.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="assistant-compose-actions">
                <button
                  type="button"
                  className="toolbar-btn primary"
                  disabled={!canApplyProposal || draftResult.conflicts.length > 0}
                  onClick={() => applyLastDraft(false)}
                >
                  {alreadyApplied ? "Applied" : "Apply to Build"}
                </button>
                {draftResult.conflicts.length > 0 && lastRun?.status === "draft" ? (
                  <button
                    type="button"
                    className="toolbar-btn"
                    disabled={alreadyApplied}
                    onClick={() => applyLastDraft(true)}
                  >
                    Apply anyway
                  </button>
                ) : null}
                {!draftResult.canSolve ? (
                  <span className="assistant-hint">Board or other inputs still required before Solve</span>
                ) : (
                  <span className="assistant-hint ok">Ready to solve when you confirm the Build form</span>
                )}
              </div>
            </div>
          ) : null}

          {setupMeta?.profile ? (
            <div className="assistant-meta">
              <strong>Active profile</strong>
              <span>
                {setupMeta.profile.displayName} · rev {String(setupMeta.profileDataRevision ?? setupMeta.profile.revision)} ·{" "}
                {setupMeta.profile.classification}
              </span>
              {!setupMeta.canSolve ? (
                <span className="assistant-hint">Solve blocked until missing fields are filled</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
