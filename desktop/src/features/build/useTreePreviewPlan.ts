/**
 * Debounced tree_preview → memory plan for Build (shared by Solve bar + Preview tree).
 * Must not run during building/solving (ZR-158 stdin starvation).
 */
import { useEffect, useRef, useState } from "react";
import { portableJobFromDraft } from "../../domain/studyJob";
import type { MemoryPlanPayload, SpotDraft, TreePreviewPayload } from "../../domain/types";
import { engineClient, EngineError } from "../../engine/client";
import { useStudyStore } from "../../state/studyStore";

function previewBlockedPhase(phase: string): boolean {
  return (
    phase === "building" ||
    phase === "solving" ||
    phase === "pause_requested" ||
    phase === "stop_requested"
  );
}

function draftPreviewBody(draft: SpotDraft): { text: string } {
  return { text: portableJobFromDraft(draft).street_config };
}

export function useTreePreviewPlan() {
  const draft = useStudyStore((s) => s.draft);
  const phase = useStudyStore((s) => s.phase);
  const [preview, setPreview] = useState<TreePreviewPayload | null>(null);
  const [plan, setPlan] = useState<MemoryPlanPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const draftRevision = useRef(0);

  const clearStalePreview = () => {
    draftRevision.current += 1;
    setPreview(null);
    setPlan(null);
    setError("");
  };

  const refresh = async () => {
    if (previewBlockedPhase(useStudyStore.getState().phase)) {
      return;
    }
    const id = ++requestId.current;
    const revision = draftRevision.current;
    setBusy(true);
    setError("");
    try {
      const tree = await engineClient.treePreview(draftPreviewBody(draft));
      if (id !== requestId.current || revision !== draftRevision.current) {
        return;
      }
      setPreview(tree);
      setPlan(tree.plan ?? null);
    } catch (err) {
      if (id !== requestId.current || revision !== draftRevision.current) {
        return;
      }
      const message =
        err instanceof EngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Tree preview failed";
      setError(message);
      setPreview(null);
      setPlan(null);
    } finally {
      if (id === requestId.current) {
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    clearStalePreview();
    if (previewBlockedPhase(phase)) {
      return;
    }
    const handle = window.setTimeout(() => {
      void refresh();
    }, 350);
    return () => window.clearTimeout(handle);
    // Spot + bet + edit fields that reshape the public tree / memory plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    draft.boardText,
    draft.oopRange,
    draft.ipRange,
    draft.pot,
    draft.stack,
    draft.oopBets,
    draft.ipBets,
    draft.oopRaises,
    draft.ipRaises,
    draft.oopFlop,
    draft.ipFlop,
    draft.oopTurn,
    draft.ipTurn,
    draft.oopRiver,
    draft.ipRiver,
    draft.oopFlopRaises,
    draft.ipFlopRaises,
    draft.oopTurnRaises,
    draft.ipTurnRaises,
    draft.oopRiverRaises,
    draft.ipRiverRaises,
    draft.oopDonk,
    draft.oopFlopDonk,
    draft.oopTurnDonk,
    draft.oopRiverDonk,
    draft.donkFlop,
    draft.donkTurn,
    draft.donkRiver,
    draft.mergeThresholdPct,
    draft.potCap,
    draft.noThreeBet,
    draft.allInThreshold,
    draft.maxRaises,
    draft.memoryMib,
    draft.threads,
    draft.treeEdits,
    draft.iterations,
    draft.accuracy,
    draft.timeLimit,
    draft.algorithm,
    draft.samples,
    draft.rakeRate,
    draft.rakeCap,
    draft.useIcm,
    draft.icmStacks,
    draft.icmPayouts,
    draft.incentives,
    draft.edgeTags,
  ]);

  return { preview, plan, error, busy, refresh };
}
