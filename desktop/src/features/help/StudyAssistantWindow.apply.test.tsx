import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const turnMock = vi.fn();

vi.mock("../../platform/credentials", () => ({
  hasAssistantOpenAiCredential: async () => false,
  getAssistantOpenAiCredential: async () => ({ value: null, source: "none" as const }),
  setAssistantOpenAiCredential: async () => "browser" as const,
  clearAssistantOpenAiCredential: async () => undefined,
  describeCredentialSource: () => "none",
  isTauriRuntime: () => false,
}));

vi.mock("../../domain/assistant/unifiedChat", async () => {
  const actual = await vi.importActual<typeof import("../../domain/assistant/unifiedChat")>(
    "../../domain/assistant/unifiedChat",
  );
  return {
    ...actual,
    createFakeUnifiedChatClient: () => ({ turn: turnMock }),
    createOpenAiUnifiedChatClient: () => ({ turn: turnMock }),
  };
});

const { useHelpChatStore } = await import("../../state/helpChatStore");
const { useStudyStore } = await import("../../state/studyStore");
const { StudyAssistantWindow } = await import("./StudyAssistantWindow");
const { DEFAULT_SPOT } = await import("../../domain/types");

function scalarPotOutcome(revision: number) {
  return {
    kind: "setup" as const,
    provider: "fake" as const,
    message: "Prepared update study · fields pot · Solve stays separate until you run it.",
    proposal: {
      kind: "update_study" as const,
      intent: { mode: "edit" as const },
      fieldEdits: { pot: 55 },
    },
    run: {
      status: "draft" as const,
      runId: 7,
      requestRevision: revision,
      result: {
        ok: true,
        mode: "edit" as const,
        draftPatch: { pot: 55 },
        pot: 55,
        provenance: { pot: "explicit_request" as const },
        conflicts: [],
        missing: [],
        summary: ["Pot set to 55"],
        canSolve: true,
        requestRevision: revision,
      },
    },
  };
}

function broadCreateOutcome(revision: number) {
  return {
    kind: "setup" as const,
    provider: "fake" as const,
    message: "Prepared prepare study · Solve stays separate until you run it.",
    proposal: {
      kind: "prepare_study" as const,
      intent: { mode: "create" as const, potType: "SRP" as const },
    },
    run: {
      status: "draft" as const,
      runId: 8,
      requestRevision: revision,
      result: {
        ok: true,
        mode: "create" as const,
        draftPatch: {
          pot: 5.5,
          stack: 97.5,
          oopRange: "QQ+",
          ipRange: "JJ+",
          boardText: "",
        },
        provenance: {},
        conflicts: [],
        missing: [
          {
            field: "boardText",
            message: "Board required",
            reason: "missing",
          },
        ],
        summary: ["Prepared CO vs BB SRP"],
        canSolve: false,
        requestRevision: revision,
      },
    },
  };
}

describe("StudyAssistantWindow apply UX", () => {
  beforeEach(() => {
    turnMock.mockReset();
    useHelpChatStore.setState({
      layout: {
        ...useHelpChatStore.getState().layout,
        visible: true,
        x: 40,
        y: 40,
        width: 420,
        height: 520,
      },
    });
    useStudyStore.setState({
      draft: {
        ...DEFAULT_SPOT,
        pot: 100,
        stack: 200,
        boardText: "Ah Kh Qh Jh Th",
        oopRange: "AA",
        ipRange: "KK",
      },
      draftRevision: 0,
      canUndoSetup: false,
      setupMeta: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  async function sendPrompt(user: ReturnType<typeof userEvent.setup>, text: string) {
    const box = screen.getByPlaceholderText(/Ask anything/i);
    await user.click(box);
    await user.clear(box);
    await user.paste(text);
    await user.click(screen.getByRole("button", { name: /^Send$/i }));
  }

  it("auto-applies a scalar pot edit with a receipt and Undo", async () => {
    turnMock.mockResolvedValue(scalarPotOutcome(0));
    const user = userEvent.setup();
    render(<StudyAssistantWindow />);
    await sendPrompt(user, "Set pot to 55");

    await waitFor(() => {
      expect(screen.getByText(/Pot: 100 . 55/)).toBeTruthy();
    });
    expect(useStudyStore.getState().draft.pot).toBe(55);
    expect(screen.getByRole("button", { name: /^Undo$/i })).toBeTruthy();
    expect(screen.queryByTestId("assistant-pending-apply")).toBeNull();
  });

  it("shows Apply for a broad create proposal instead of claiming it was written", async () => {
    turnMock.mockResolvedValue(broadCreateOutcome(0));
    const user = userEvent.setup();
    render(<StudyAssistantWindow />);
    await sendPrompt(user, "Set up CO vs BB SRP");

    await waitFor(() => {
      expect(screen.getByTestId("assistant-pending-apply")).toBeTruthy();
    });
    expect(screen.getByText(/Click Apply to write these onto Build/i)).toBeTruthy();
    expect(useStudyStore.getState().draft.oopRange).toBe("AA");

    await user.click(screen.getByRole("button", { name: /Apply to Build/i }));
    await waitFor(() => {
      expect(useStudyStore.getState().draft.oopRange).toBe("QQ+");
    });
    expect(useStudyStore.getState().draft.pot).toBe(5.5);
    expect(screen.queryByTestId("assistant-pending-apply")).toBeNull();
  });
});
