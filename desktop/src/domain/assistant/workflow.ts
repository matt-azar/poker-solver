import { isStaleProposal, type SetupDraftResult, type StudySetupPreferences } from "../setup";
import type { RangeProfileCatalogue } from "../profiles";
import type { SpotDraft } from "../types";
import {
  AssistantProviderError,
  type AssistantProvider,
  type InterpretProposal,
  type ProfileMeta,
} from "./provider";
import { catalogueProfileMetas, resolveAssistantProposal } from "./resolve";
import type { CatalogueLike } from "./resolve";

export type AssistantRunStatus =
  | "draft"
  | "clarify"
  | "unsupported"
  | "unrelated"
  | "stale"
  | "cancelled"
  | "error";

export interface AssistantRunResult {
  status: AssistantRunStatus;
  result?: SetupDraftResult;
  proposal?: InterpretProposal;
  error?: AssistantProviderError | Error;
  message?: string;
  /** Monotonic id for this run — retries must not double-apply. */
  runId: number;
  requestRevision: number;
}

export interface AssistantRunContext {
  provider: AssistantProvider;
  catalogue: RangeProfileCatalogue | CatalogueLike;
  getDraft: () => SpotDraft;
  getRevision: () => number;
  preferences: StudySetupPreferences;
  signal?: AbortSignal;
  setupSummary?: string;
  preferencesSummary?: string;
  capabilities?: string[];
  availableProfiles?: ProfileMeta[];
}

export interface AssistantSession {
  /** Interpret + resolve once per run id. Apply is the caller's job. */
  run(text: string, ctx: AssistantRunContext): Promise<AssistantRunResult>;
  /** Cancel the in-flight run, if any. */
  cancel(): void;
  /** Currently in-flight run id, or null. */
  inFlightRunId(): number | null;
}

/**
 * In-memory assistant session (no React). Tracks in-flight request identity,
 * AbortSignal cancellation, and revision freshness via isStaleProposal.
 * Retries allocate a new run id; the session never applies patches itself.
 */
export function createAssistantSession(): AssistantSession {
  let nextRunId = 1;
  let inFlight: { runId: number; aborted: boolean } | null = null;
  let abortController: AbortController | null = null;

  return {
    inFlightRunId() {
      return inFlight?.runId ?? null;
    },

    cancel() {
      if (inFlight) {
        inFlight.aborted = true;
      }
      abortController?.abort();
      abortController = null;
    },

    async run(text: string, ctx: AssistantRunContext): Promise<AssistantRunResult> {
      // Cancel any previous in-flight work; this run is authoritative.
      if (inFlight) {
        inFlight.aborted = true;
        abortController?.abort();
      }

      const runId = nextRunId++;
      const local = { runId, aborted: false };
      inFlight = local;
      abortController = new AbortController();

      const external = ctx.signal;
      const onExternalAbort = () => {
        local.aborted = true;
        abortController?.abort();
      };
      if (external) {
        if (external.aborted) {
          local.aborted = true;
        } else {
          external.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      const requestRevision = ctx.getRevision();

      const finish = (result: AssistantRunResult): AssistantRunResult => {
        if (inFlight?.runId === runId) {
          inFlight = null;
          abortController = null;
        }
        if (external) {
          external.removeEventListener("abort", onExternalAbort);
        }
        return result;
      };

      if (local.aborted) {
        return finish({
          status: "cancelled",
          message: "Request cancelled",
          runId,
          requestRevision,
        });
      }

      try {
        const availableProfiles =
          ctx.availableProfiles ?? catalogueProfileMetas(ctx.catalogue);

        const proposal = await ctx.provider.interpret({
          text,
          setupSummary: ctx.setupSummary ?? "",
          availableProfiles,
          capabilities: ctx.capabilities ?? [
            "prepare_study",
            "update_study",
            "duplicate_study",
            "clarify",
            "unsupported",
            "unrelated",
          ],
          preferencesSummary: ctx.preferencesSummary,
          draftRevision: requestRevision,
        });

        if (local.aborted || abortController?.signal.aborted) {
          return finish({
            status: "cancelled",
            proposal,
            message: "Request cancelled",
            runId,
            requestRevision,
          });
        }

        // Discard if the player edited the draft while we were interpreting.
        const currentRevision = ctx.getRevision();
        if (isStaleProposal(requestRevision, currentRevision)) {
          return finish({
            status: "stale",
            proposal,
            message: `Stale proposal: request revision ${requestRevision}, current ${currentRevision}`,
            runId,
            requestRevision,
          });
        }

        if (proposal.kind === "clarify") {
          const result = resolveAssistantProposal({
            proposal,
            baseDraft: ctx.getDraft(),
            catalogue: ctx.catalogue,
            preferences: ctx.preferences,
            draftRevision: requestRevision,
          });
          return finish({
            status: "clarify",
            proposal,
            result,
            message: proposal.questions[0],
            runId,
            requestRevision,
          });
        }

        if (proposal.kind === "unsupported") {
          return finish({
            status: "unsupported",
            proposal,
            result: resolveAssistantProposal({
              proposal,
              baseDraft: ctx.getDraft(),
              catalogue: ctx.catalogue,
              preferences: ctx.preferences,
              draftRevision: requestRevision,
            }),
            message: proposal.message,
            runId,
            requestRevision,
          });
        }

        if (proposal.kind === "unrelated") {
          return finish({
            status: "unrelated",
            proposal,
            result: resolveAssistantProposal({
              proposal,
              baseDraft: ctx.getDraft(),
              catalogue: ctx.catalogue,
              preferences: ctx.preferences,
              draftRevision: requestRevision,
            }),
            message: proposal.message,
            runId,
            requestRevision,
          });
        }

        const result = resolveAssistantProposal({
          proposal,
          baseDraft: ctx.getDraft(),
          catalogue: ctx.catalogue,
          preferences: ctx.preferences,
          draftRevision: requestRevision,
        });

        // Re-check freshness after resolve (cheap; draft may have changed).
        if (isStaleProposal(requestRevision, ctx.getRevision())) {
          return finish({
            status: "stale",
            proposal,
            result,
            message: "Draft changed before resolution completed",
            runId,
            requestRevision,
          });
        }

        if (local.aborted) {
          return finish({
            status: "cancelled",
            proposal,
            result,
            message: "Request cancelled",
            runId,
            requestRevision,
          });
        }

        // Clarify-shaped resolution (ambiguous profiles) even if model prepared a study.
        if (
          result.missing.some((m) => m.reason === "needs_clarification") ||
          result.conflicts.some((c) => c.field === "profile")
        ) {
          return finish({
            status: "clarify",
            proposal,
            result,
            message: result.missing[0]?.message ?? result.summary[0],
            runId,
            requestRevision,
          });
        }

        return finish({
          status: "draft",
          proposal,
          result,
          runId,
          requestRevision,
        });
      } catch (err) {
        if (local.aborted || (err instanceof Error && err.name === "AbortError")) {
          return finish({
            status: "cancelled",
            message: "Request cancelled",
            runId,
            requestRevision,
          });
        }
        const error =
          err instanceof AssistantProviderError
            ? err
            : err instanceof Error
              ? err
              : new Error(String(err));
        return finish({
          status: "error",
          error,
          message: error.message,
          runId,
          requestRevision,
        });
      }
    },
  };
}
