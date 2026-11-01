/**
 * Model-facing context packs (authored under docs/ai-context/).
 * Imported as raw markdown and injected into system prompts.
 */
import helpContextMd from "../../../../docs/ai-context/help.md?raw";
import setupAssistantContextMd from "../../../../docs/ai-context/setup-assistant.md?raw";
import unifiedContextMd from "../../../../docs/ai-context/unified.md?raw";

export type AssistantContextKind = "help" | "setup-assistant" | "unified";

const PACKS: Record<AssistantContextKind, string> = {
  help: String(helpContextMd),
  "setup-assistant": String(setupAssistantContextMd),
  unified: String(unifiedContextMd),
};

/** Raw markdown for a context kind (trimmed). */
export function loadAssistantContextPack(kind: AssistantContextKind): string {
  return PACKS[kind].trim();
}

/** System prompt for help-only answers (section pack). */
export function buildHelpSystemPrompt(pack = loadAssistantContextPack("help")): string {
  return [
    pack,
    "",
    "## Reply format",
    "- Answer in plain language for a poker player using the desktop app.",
    "- Keep answers short unless the player asks for detail.",
  ].join("\n");
}

/**
 * System prompt for the Setup assistant OpenAI path (tool-only interpret).
 */
export function buildSetupAssistantSystemPrompt(
  pack = loadAssistantContextPack("setup-assistant"),
): string {
  return [
    "You interpret poker study-setup requests for a postflop solver Build workspace.",
    "Emit only the emit_study_setup_proposal tool with schema-constrained fields.",
    "Prefer exact availableProfiles ids when they match pot type, rake structure, seats, and stack.",
    "When no exact profile fits but two profiles straddle the target stack (same seats/pot/rake), set interpolateFromIds to those two ids and the target stackBb — do not invent frequencies.",
    "When no catalogue row and no interpolatable bracket exist, you may set generatedRanges {oop,ip} as weighted combo text (AA,AKs,AKo:0.5,…). Mark note that it is model-proposed, not equilibrium.",
    "Never emit scripts, shell commands, file paths, or network URLs.",
    "Use clarify when ambiguous, unsupported for strategy explanations/preflop solves, unrelated for non-poker text.",
    "",
    "--- Context pack ---",
    pack,
  ].join("\n");
}

/** System prompt for the floating unified Study assistant (multi-tool). */
export function buildUnifiedAssistantSystemPrompt(
  pack = loadAssistantContextPack("unified"),
): string {
  return [
    pack,
    "",
    "--- Help section ---",
    loadAssistantContextPack("help"),
    "",
    "--- Setup section ---",
    loadAssistantContextPack("setup-assistant"),
    "",
    "Call exactly one tool: answer_user OR emit_study_setup_proposal.",
  ].join("\n");
}
