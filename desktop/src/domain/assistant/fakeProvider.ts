import type { StudySetupIntent, StudySetupTreePreset } from "../setup/types";
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

    // Alternative BB calling range.
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
          "Which alternative BB calling range profile should I use?",
        ],
        candidates: alts.length > 0 ? alts : request.availableProfiles,
      };
    }

    // CO vs BB SRP / prepare study.
    const coVsBb =
      /\bco\s*vs\.?\s*bb\b/i.test(text) ||
      /\bset\s*up\b[\s\S]*\bco\b[\s\S]*\bbb\b/i.test(text);

    const wantsSetup =
      /\bset\s*up\b/i.test(text) ||
      /\bprepare\b/i.test(text) ||
      /\bcreate\b/i.test(text) ||
      /\busing\s+my\b/i.test(text) ||
      /\bsrp\b/i.test(text);

    if (coVsBb || (wantsSetup && /\bco\b/i.test(text) && /\bbb\b/i.test(text))) {
      const stakesLabel = extractStakesLabel(text);
      const coBbProfiles = request.availableProfiles.filter(
        (p) =>
          p.positions.oop.toUpperCase() === "BB" &&
          p.positions.ip.toUpperCase() === "CO",
      );

      let candidates = coBbProfiles;
      if (stakesLabel) {
        const filtered = candidates.filter(
          (p) =>
            p.stakesLabel?.toUpperCase() === stakesLabel.toUpperCase(),
        );
        if (filtered.length > 0) {
          candidates = filtered;
        }
      }

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
            "No matching CO vs BB range profile was found. Import a profile or pick one from the catalogue.",
          ],
          candidates: request.availableProfiles,
        };
      }

      if (candidates.length > 1) {
        return {
          kind: "clarify",
          questions: [
            "Multiple CO vs BB profiles match. Which profile should I use?",
          ],
          candidates,
        };
      }

      const chosen = candidates[0]!;
      const intent: StudySetupIntent = {
        mode: "create",
        oopPosition: "BB",
        ipPosition: "CO",
        stakesLabel,
        profileQuery: chosen.id,
        openSizeBb: chosen.openSizeBb,
      };
      return {
        kind: "prepare_study",
        intent,
        selectedProfileId: chosen.id,
        stakesLabel,
        openSizeBb: chosen.openSizeBb,
      };
    }

    // Stakes-only / "100NL" without positions → clarify (never invent stack).
    const stakesOnly = extractStakesLabel(text);
    if (
      stakesOnly &&
      !/\bco\b/i.test(text) &&
      !/\bbb\b/i.test(text) &&
      !/\bboard\b/i.test(text) &&
      !/\bflop\b/i.test(text)
    ) {
      const stakeProfiles = request.availableProfiles.filter(
        (p) => p.stakesLabel?.toUpperCase() === stakesOnly.toUpperCase(),
      );
      return {
        kind: "clarify",
        questions: [
          `${stakesOnly} is a stakes label and does not set stack depth. Which positions/profile should I use?`,
        ],
        candidates: stakeProfiles.length > 0 ? stakeProfiles : undefined,
      };
    }

    // Ambiguous poker-ish request without a resolvable profile.
    if (
      /\b(range|profile|setup|study|pot|stack|bb|nl|flop|board|oop|ip)\b/i.test(
        text,
      )
    ) {
      return {
        kind: "clarify",
        questions: [
          "I need a clearer study-setup request (e.g. “Set up CO vs BB using my 100NL profile”).",
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

function extractStakesLabel(text: string): string | undefined {
  const match = text.match(/\b(\d+)\s*NL\b/i);
  return match ? `${match[1]}NL` : undefined;
}

function extractOpenSize(text: string): number | undefined {
  const xMatch = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  if (xMatch) {
    return Number(xMatch[1]);
  }
  const openMatch = text.match(/\bopen(?:ing)?\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*bb\b/i);
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
  // Default when "flop bets" mentioned without seat: IP (common phrasing in brief).
  if (/\bflop\s+bets?\b/i.test(text)) {
    return { ipFlop: serialized };
  }
  return undefined;
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
