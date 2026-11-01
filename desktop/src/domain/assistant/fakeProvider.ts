import {
  DEFAULT_RAKE_ENVIRONMENT,
  DEFAULT_STARTING_STACK_BB,
  type PotType,
  type StudySetupIntent,
  type StudySetupTreePreset,
} from "../setup";
import {
  ASSISTANT_MAX_TEXT_LENGTH,
  AssistantProviderError,
  type AssistantProvider,
  type InterpretProposal,
  type InterpretRequest,
  type ProfileMeta,
} from "./provider";

/**
 * Deterministic FakeAssistantProvider for automated tests and local demos.
 * Not the shipped natural-language feature — never invents range weight strings.
 *
 * Product semantics:
 * - Pot type (SRP / 3BP / 4BP) is required for create; never guessed.
 * - "100NL" is a rake/stakes-environment key, not a personal profile.
 * - Unspecified rake structure defaults to cEV (chip EV / no rake).
 * - Unspecified stacks default to 100bb (independent of any NL label).
 * - Catalogue matching prefers standard/GTO entries keyed by rake + action +
 *   positions + stacks — not personal "my … profile" naming.
 */
export class FakeAssistantProvider implements AssistantProvider {
  async interpret(request: InterpretRequest): Promise<InterpretProposal> {
    const raw = request.text ?? "";
    if (raw.length > ASSISTANT_MAX_TEXT_LENGTH) {
      throw new AssistantProviderError(
        "text_too_long",
        `Request text exceeds ${ASSISTANT_MAX_TEXT_LENGTH} characters`,
      );
    }

    const text = raw.trim();
    const lower = text.toLowerCase();

    if (!text) {
      return {
        kind: "clarify",
        questions: ["What study setup would you like to prepare or change?"],
      };
    }

    // Unsupported: strategy explanations / preflop solving / research.
    if (
      /\bexplain\b.*\bgto\b/i.test(text) ||
      /\bgto\b.*\bstrateg/i.test(text) ||
      /\bsolve\s+preflop\b/i.test(text) ||
      /\bpreflop\s+solver?\b/i.test(text) ||
      /\bresearch\b.*\bspots?\b/i.test(text)
    ) {
      return {
        kind: "unsupported",
        message:
          "Strategy explanations and preflop solves are outside study setup. Use Build controls after preparing a postflop study.",
      };
    }

    // Duplicate at N bb.
    const dupMatch = lower.match(
      /duplicate\s+(?:this\s+)?(?:setup|study|spot)?\s*(?:at|to|with)?\s*(\d+(?:\.\d+)?)\s*bb/,
    );
    if (dupMatch || /duplicate\s+(?:this\s+)?setup/.test(lower)) {
      const stackBb = dupMatch ? Number(dupMatch[1]) : undefined;
      const intent: StudySetupIntent = {
        mode: "duplicate",
        stackBb: Number.isFinite(stackBb) ? stackBb : undefined,
      };
      return {
        kind: "duplicate_study",
        intent,
        stackBb: intent.stackBb,
      };
    }

    // Board update: "Change the flop to As 7d 2c" or similar board patterns.
    const board = extractBoard(text);
    if (
      board &&
      (/\b(change|set|use|update)\b.*\b(flop|board|turn|river)\b/i.test(text) ||
        /\b(flop|board)\b.*\b(to|=)\b/i.test(text) ||
        /^[aksqjt98765432][shdc](?:\s+[aksqjt98765432][shdc]){2,4}$/i.test(
          text.trim(),
        ))
    ) {
      const intent: StudySetupIntent = {
        mode: "edit",
        board,
      };
      return {
        kind: "update_study",
        intent,
        board,
      };
    }

    // Tree edits: "Use 33% and 75% flop bets for IP"
    const treeEdits = extractTreeEdits(text);
    if (treeEdits) {
      const intent: StudySetupIntent = {
        mode: "edit",
        treePreset: treeEdits,
      };
      return {
        kind: "update_study",
        intent,
        treeEdits,
      };
    }

    // Alternative BB calling range (standard catalogue entry, not a personal profile).
    if (
      /alternative\s+bb\s+(calling\s+)?range/i.test(text) ||
      /alternate\s+bb\s+(calling\s+)?range/i.test(text) ||
      /other\s+bb\s+(calling\s+)?range/i.test(text) ||
      /\bbb\s+calling\s+range\b.*\b(3x|alternative|alternate)\b/i.test(text)
    ) {
      const alts = findAlternativeBbProfiles(request.availableProfiles);
      if (alts.length === 1) {
        const chosen = alts[0]!;
        const intent: StudySetupIntent = {
          mode: "edit",
          oopPosition: "BB",
          ipPosition: "CO",
          potType: chosen.potType ?? "SRP",
          profileQuery: chosen.id,
        };
        return {
          kind: "update_study",
          intent,
          selectedProfileId: chosen.id,
        };
      }
      return {
        kind: "clarify",
        questions: [
          "Which alternative BB calling range from the standard catalogue should I use?",
        ],
        candidates: alts.length > 0 ? alts : request.availableProfiles,
      };
    }

    // CO vs BB prepare / create.
    const coVsBb =
      /\bco\s*vs\.?\s*bb\b/i.test(text) ||
      /\bset\s*up\b[\s\S]*\bco\b[\s\S]*\bbb\b/i.test(text);

    const wantsSetup =
      /\bset\s*up\b/i.test(text) ||
      /\bprepare\b/i.test(text) ||
      /\bcreate\b/i.test(text) ||
      /\busing\b/i.test(text) ||
      /\bsrp\b/i.test(text) ||
      /\b3bp\b/i.test(text) ||
      /\b4bp\b/i.test(text);

    if (coVsBb || (wantsSetup && /\bco\b/i.test(text) && /\bbb\b/i.test(text))) {
      const potType = extractPotType(text);
      if (!potType) {
        return {
          kind: "clarify",
          questions: [
            "Which pot type / preflop action should I use — SRP, 3BP, or 4BP? Ranges depend on that action (plus rake structure, stacks, and positions).",
          ],
          candidates: request.availableProfiles.filter(
            (p) =>
              p.positions.oop.toUpperCase() === "BB" &&
              p.positions.ip.toUpperCase() === "CO",
          ),
        };
      }

      const explicitRake = extractRakeLabel(text);
      const rakeLabel = explicitRake ?? DEFAULT_RAKE_ENVIRONMENT;
      const explicitStack = extractStackBb(text);
      const stackBb = explicitStack ?? DEFAULT_STARTING_STACK_BB;

      let candidates = request.availableProfiles.filter(
        (p) =>
          p.positions.oop.toUpperCase() === "BB" &&
          p.positions.ip.toUpperCase() === "CO" &&
          (p.potType === undefined || p.potType === potType) &&
          p.startingStackBb === stackBb &&
          rakeEnvironmentAgrees(p.stakesLabel, rakeLabel),
      );

      // Only put rake/stack on the proposal when the player named them. Silence
      // defaults (cEV / 100bb) are applied in resolve so summaries stay honest.

      // Prefer standard/GTO-shaped catalogue rows over personal_adjustment when several match.
      candidates = preferStandardCatalogue(candidates);

      // Prefer 2.5x open when multiple and no open size mentioned.
      const openMention = extractOpenSize(text);
      if (openMention !== undefined) {
        candidates = candidates.filter((p) => p.openSizeBb === openMention);
      } else if (candidates.length > 1) {
        const preferred = candidates.filter((p) => p.openSizeBb === 2.5);
        if (preferred.length === 1) {
          candidates = preferred;
        }
      }

      // Match by fixture id / display name tokens when present in text.
      const byId = candidates.filter(
        (p) =>
          lower.includes(p.id.toLowerCase()) ||
          (p.displayName && lower.includes(p.displayName.toLowerCase())),
      );
      if (byId.length === 1) {
        candidates = byId;
      }

      if (candidates.length === 0) {
        return {
          kind: "clarify",
          questions: [
            `No matching standard/GTO CO vs BB ${potType} catalogue entry was found for ${rakeLabel} at ${stackBb}bb. Import ranges or pick one from the catalogue.`,
          ],
          candidates: request.availableProfiles,
        };
      }

      if (candidates.length > 1) {
        return {
          kind: "clarify",
          questions: [
            `Multiple CO vs BB ${potType} catalogue entries match. Which standard/GTO entry should I use?`,
          ],
          candidates,
        };
      }

      const chosen = candidates[0]!;
      const intent: StudySetupIntent = {
        mode: "create",
        oopPosition: "BB",
        ipPosition: "CO",
        potType,
        profileQuery: chosen.id,
        openSizeBb: chosen.openSizeBb,
      };
      if (explicitRake) {
        intent.stakesLabel = explicitRake;
      }
      if (explicitStack !== undefined) {
        intent.stackBb = explicitStack;
      }
      return {
        kind: "prepare_study",
        intent,
        selectedProfileId: chosen.id,
        openSizeBb: chosen.openSizeBb,
        stakesLabel: explicitRake,
        stackBb: explicitStack,
      };
    }

    // Rake-only / "100NL" without positions or pot type → clarify (never invent stack from NL).
    const rakeOnly = extractRakeLabel(text);
    if (
      rakeOnly &&
      !/\bco\b/i.test(text) &&
      !/\bbb\b/i.test(text) &&
      !/\bboard\b/i.test(text) &&
      !/\bflop\b/i.test(text)
    ) {
      const stakeProfiles = request.availableProfiles.filter(
        (p) => p.stakesLabel?.toUpperCase() === rakeOnly.toUpperCase(),
      );
      return {
        kind: "clarify",
        questions: [
          `${rakeOnly} names a rake structure / stakes environment, not a personal profile or stack depth. Which positions and pot type (SRP / 3BP / 4BP) should I use?`,
        ],
        candidates: stakeProfiles.length > 0 ? stakeProfiles : undefined,
      };
    }

    // Ambiguous poker-ish request without a resolvable catalogue entry.
    if (
      /\b(range|profile|setup|study|pot|stack|bb|nl|flop|board|oop|ip|srp|3bp|4bp|gto)\b/i.test(
        text,
      )
    ) {
      return {
        kind: "clarify",
        questions: [
          "I need a clearer study-setup request (e.g. “Set up CO vs BB SRP with 100NL ranges”).",
        ],
        candidates:
          request.availableProfiles.length > 0
            ? request.availableProfiles
            : undefined,
      };
    }

    // Gibberish / non-poker.
    return {
      kind: "unrelated",
      message:
        "That does not look like a study setup request. Ask about preparing or editing a postflop study.",
    };
  }
}

/**
 * Explicit rake/stakes-environment label from text.
 * "100NL" / "200NL" → rake structure. "cEV" / "chip EV" / "no rake" → cEV.
 * Personal phrases like "my 100NL profile" still yield the rake key only.
 */
function extractRakeLabel(text: string): string | undefined {
  if (/\bc\s*ev\b|\bchip\s*ev\b|\bno\s*rake\b/i.test(text)) {
    return DEFAULT_RAKE_ENVIRONMENT;
  }
  const match = text.match(/\b(\d+)\s*NL\b/i);
  return match ? `${match[1]}NL` : undefined;
}

/** Case-insensitive rake-environment agreement (cEV ↔ chip EV aliases). */
function rakeEnvironmentAgrees(
  profileLabel: string | undefined,
  queryLabel: string,
): boolean {
  const want = normalizeRakeLabel(queryLabel);
  const got = normalizeRakeLabel(profileLabel);
  return got === want;
}

function normalizeRakeLabel(label: string | undefined): string {
  const raw = (label ?? "").trim().toUpperCase();
  if (!raw || raw === "CEV" || raw === "CHIP EV" || raw === "CHIP_EV" || raw === "NONE") {
    return DEFAULT_RAKE_ENVIRONMENT.toUpperCase();
  }
  return raw.replace(/\s+/g, "");
}

function extractPotType(text: string): PotType | undefined {
  if (/\b4bp\b|\b4[- ]?bet(?:ting)?\s+pot\b|\bfour[- ]bet\s+pot\b/i.test(text)) {
    return "4BP";
  }
  if (
    /\b3bp\b|\b3[- ]?bet(?:ting)?\s+pot\b|\bthree[- ]bet\s+pot\b|\b3[- ]?bet\s+pot\b/i.test(
      text,
    )
  ) {
    return "3BP";
  }
  if (
    /\bsrp\b|\bsingle[- ]raised?\s+pot\b|\bsingle[- ]raise\s+pot\b/i.test(text)
  ) {
    return "SRP";
  }
  return undefined;
}

function extractStackBb(text: string): number | undefined {
  // Explicit depth like "100bb" / "at 150 bb" — never from "100NL".
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*bb\b/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractOpenSize(text: string): number | undefined {
  const xMatch = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  if (xMatch) {
    return Number(xMatch[1]);
  }
  const openMatch = text.match(
    /\bopen(?:ing)?\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*bb\b/i,
  );
  if (openMatch) {
    return Number(openMatch[1]);
  }
  return undefined;
}

const CARD_RE = /[AKSQJT98765432][shdc]/gi;

function extractBoard(text: string): string | undefined {
  const cards = text.match(CARD_RE);
  if (!cards || cards.length < 3) {
    return undefined;
  }
  // Take first contiguous run of 3–5 cards.
  const run: string[] = [];
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    if (CARD_RE.test(token)) {
      run.push(token.match(CARD_RE)![0]!);
      if (run.length === 5) {
        break;
      }
    } else if (run.length >= 3) {
      break;
    } else {
      run.length = 0;
    }
  }
  if (run.length >= 3) {
    return run.join(" ");
  }
  return undefined;
}

function extractTreeEdits(text: string): StudySetupTreePreset | undefined {
  // "Use 33% and 75% flop bets for IP"
  const pcts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) =>
    Number(m[1]),
  );
  if (pcts.length < 2) {
    return undefined;
  }
  if (!/\bflop\b/i.test(text) || !/\bbets?\b/i.test(text)) {
    return undefined;
  }
  const fractions = pcts.map((p) => (p > 1 ? p / 100 : p));
  const serialized = fractions.map((f) => String(Number(f.toFixed(4)))).join(", ");
  const forIp = /\b(ip|in\s*position)\b/i.test(text);
  const forOop = /\b(oop|out\s*of\s*position)\b/i.test(text);
  if (forIp || (!forOop && /\bfor\s+ip\b/i.test(text))) {
    return { ipFlop: serialized };
  }
  if (forOop) {
    return { oopFlop: serialized };
  }
  // Default when "flop bets" mentioned without seat: IP (common phrasing).
  if (/\bflop\s+bets?\b/i.test(text)) {
    return { ipFlop: serialized };
  }
  return undefined;
}

function preferStandardCatalogue(profiles: ProfileMeta[]): ProfileMeta[] {
  const standard = profiles.filter(
    (p) =>
      p.classification === "equilibrium_model" ||
      p.classification === "synthetic_fixture" ||
      /gto|standard|equilibrium/i.test(p.displayName) ||
      p.classification !== "personal_adjustment",
  );
  // Drop personal_adjustment when any non-personal entry remains.
  const withoutPersonal = profiles.filter(
    (p) => p.classification !== "personal_adjustment",
  );
  if (withoutPersonal.length > 0 && withoutPersonal.length < profiles.length) {
    return withoutPersonal;
  }
  return standard.length > 0 ? standard : profiles;
}

function findAlternativeBbProfiles(profiles: ProfileMeta[]): ProfileMeta[] {
  const coBb = profiles.filter(
    (p) =>
      p.positions.oop.toUpperCase() === "BB" &&
      p.positions.ip.toUpperCase() === "CO",
  );
  // Prefer 3x open as the "alternative" calling range fixture.
  const threeX = coBb.filter((p) => p.openSizeBb === 3);
  if (threeX.length > 0) {
    return threeX;
  }
  return coBb.filter(
    (p) =>
      /3x/i.test(p.id) ||
      /3x/i.test(p.displayName) ||
      /alternative/i.test(p.displayName),
  );
}

export function createFakeAssistantProvider(): FakeAssistantProvider {
  return new FakeAssistantProvider();
}
