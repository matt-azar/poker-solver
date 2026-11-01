import { potTypeFromActions } from "../setup/derive";
import type { PotType, StudySetupIntent, StudySetupTreePreset } from "../setup/types";

/**
 * Soft upper bound on natural-language request text sent to a provider.
 * Longer text is rejected or truncated by adapters before network I/O.
 */
export const ASSISTANT_MAX_TEXT_LENGTH = 2000;

/** Compact catalogue row exposed to the model — never full range weights. */
export interface ProfileMeta {
  id: string;
  displayName: string;
  classification: string;
  positions: { oop: string; ip: string };
  startingStackBb: number;
  openSizeBb?: number;
  format: string;
  /** Rake / stakes-environment label (e.g. 100NL) — not a personal profile name. */
  stakesLabel?: string;
  potType?: PotType;
  legacyPreset?: boolean;
}

export interface InterpretRequest {
  text: string;
  /** Compact human summary of the current Build draft (no full ranges). */
  setupSummary: string;
  availableProfiles: ProfileMeta[];
  /** Capability strings the model may use (e.g. "prepare_study"). */
  capabilities: string[];
  preferencesSummary?: string;
  /** Application draft revision at request start — used for stale protection. */
  draftRevision: number;
}

/**
 * Schema-constrained model proposal. Range weights are never included —
 * only profile ids and structured field edits. The resolver loads ranges.
 */
export type InterpretProposal =
  | {
      kind: "prepare_study" | "update_study" | "duplicate_study";
      intent: StudySetupIntent;
      selectedProfileId?: string;
      board?: string;
      treeEdits?: StudySetupTreePreset;
      stackBb?: number;
      openSizeBb?: number;
      stakesLabel?: string;
    }
  | {
      kind: "clarify";
      questions: string[];
      candidates?: ProfileMeta[];
    }
  | {
      kind: "unsupported";
      message: string;
    }
  | {
      kind: "unrelated";
      message: string;
    };

export interface AssistantProvider {
  interpret(request: InterpretRequest): Promise<InterpretProposal>;
}

export type AssistantProviderErrorCode =
  | "missing_credential"
  | "network"
  | "invalid_response"
  | "rejected_payload"
  | "text_too_long"
  | "aborted";

export class AssistantProviderError extends Error {
  readonly code: AssistantProviderErrorCode;

  constructor(code: AssistantProviderErrorCode, message: string) {
    super(message);
    this.name = "AssistantProviderError";
    this.code = code;
  }
}

/** Default capability list for study-setup interpretation. */
export const DEFAULT_ASSISTANT_CAPABILITIES: readonly string[] = [
  "prepare_study",
  "update_study",
  "duplicate_study",
  "clarify",
  "unsupported",
  "unrelated",
];

export function profileToMeta(
  profile: {
    id: string;
    displayName: string;
    provenance: { classification: string };
    positions: { oop: string; ip: string };
    startingStackBb: number;
    format: string;
    labels?: { stakes?: string };
    legacyPreset?: boolean;
    preflopActions?: ReadonlyArray<{ kind: string; sizeBb?: number }>;
  },
  openSizeBb?: number,
): ProfileMeta {
  let resolvedOpen = openSizeBb;
  if (resolvedOpen === undefined && profile.preflopActions) {
    for (const action of profile.preflopActions) {
      if (action.kind === "open" && typeof action.sizeBb === "number") {
        resolvedOpen = action.sizeBb;
        break;
      }
    }
  }
  const potType = profile.preflopActions
    ? potTypeFromActions(profile.preflopActions)
    : undefined;
  return {
    id: profile.id,
    displayName: profile.displayName,
    classification: profile.provenance.classification,
    positions: { ...profile.positions },
    startingStackBb: profile.startingStackBb,
    openSizeBb: resolvedOpen,
    format: profile.format,
    stakesLabel: profile.labels?.stakes,
    potType,
    legacyPreset: profile.legacyPreset,
  };
}
