import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRangeProfileDocument } from "../profiles";
import {
  FakeAssistantProvider,
  createFakeAssistantProvider,
  profileToMeta,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const fixture25 = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json",
    ),
    "utf8",
  ),
);
const fixture3x = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-3x.json",
    ),
    "utf8",
  ),
);

const profiles = [fixture25, fixture3x].map((p) => profileToMeta(p));

function request(text: string) {
  return {
    text,
    setupSummary: "empty draft",
    availableProfiles: profiles,
    capabilities: ["prepare_study", "update_study", "duplicate_study"],
    draftRevision: 1,
  };
}

describe("FakeAssistantProvider", () => {
  const provider = createFakeAssistantProvider();

  it("prepares CO vs BB SRP with 100NL profile id (no range weights)", async () => {
    const proposal = await provider.interpret(
      request("Set up CO vs BB SRP using my 100NL profile"),
    );
    expect(proposal.kind).toBe("prepare_study");
    if (proposal.kind !== "prepare_study") return;
    expect(proposal.intent.mode).toBe("create");
    expect(proposal.intent.oopPosition).toBe("BB");
    expect(proposal.intent.ipPosition).toBe("CO");
    expect(proposal.intent.stakesLabel).toBe("100NL");
    expect(proposal.selectedProfileId).toBe(fixture25.id);
    const serialized = JSON.stringify(proposal);
    expect(serialized).not.toContain(fixture25.ranges.oop);
    expect(serialized).not.toContain(fixture25.ranges.ip);
    // Must not dump thousands of raw combos.
    expect(serialized.length).toBeLessThan(2000);
  });

  it("updates board without emitting ranges", async () => {
    const proposal = await provider.interpret(
      request("Change the flop to As 7d 2c"),
    );
    expect(proposal.kind).toBe("update_study");
    if (proposal.kind !== "update_study") return;
    expect(proposal.board).toBe("As 7d 2c");
    expect(proposal.intent.board).toBe("As 7d 2c");
    expect(JSON.stringify(proposal)).not.toMatch(/oopRange|ipRange/);
  });

  it("updates IP flop bets as structured tree edits", async () => {
    const proposal = await provider.interpret(
      request("Use 33% and 75% flop bets for IP"),
    );
    expect(proposal.kind).toBe("update_study");
    if (proposal.kind !== "update_study") return;
    expect(proposal.treeEdits?.ipFlop).toBe("0.33, 0.75");
  });

  it("duplicates setup at 150bb", async () => {
    const proposal = await provider.interpret(
      request("Duplicate this setup at 150bb"),
    );
    expect(proposal.kind).toBe("duplicate_study");
    if (proposal.kind !== "duplicate_study") return;
    expect(proposal.stackBb).toBe(150);
    expect(proposal.intent.mode).toBe("duplicate");
  });

  it("clarifies or selects alternative BB calling range when 3x fixture present", async () => {
    const proposal = await provider.interpret(
      request("Use my alternative BB calling range"),
    );
    if (proposal.kind === "update_study") {
      expect(proposal.selectedProfileId).toBe(fixture3x.id);
    } else {
      expect(proposal.kind).toBe("clarify");
      if (proposal.kind === "clarify") {
        expect(proposal.candidates?.some((c) => c.id === fixture3x.id)).toBe(
          true,
        );
      }
    }
  });

  it("marks gibberish as unrelated", async () => {
    const proposal = await provider.interpret(
      request("asdf qwer zxcv purple banana"),
    );
    expect(proposal.kind).toBe("unrelated");
  });

  it("marks GTO explanation / preflop solve as unsupported", async () => {
    const gto = await provider.interpret(
      request("explain GTO strategy for this spot"),
    );
    expect(gto.kind).toBe("unsupported");
    const preflop = await provider.interpret(request("solve preflop for UTG"));
    expect(preflop.kind).toBe("unsupported");
  });

  it("clarifies ambiguous stakes-only requests", async () => {
    const proposal = await provider.interpret(request("100NL"));
    expect(proposal.kind).toBe("clarify");
  });

  it("is constructible via class export", () => {
    expect(new FakeAssistantProvider()).toBeInstanceOf(FakeAssistantProvider);
  });
});
