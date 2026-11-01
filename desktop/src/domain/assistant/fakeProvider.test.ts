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
const fixture25Nl = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x-100nl.json",
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

const profiles = [fixture25, fixture25Nl, fixture3x].map((p) =>
  profileToMeta(p),
);

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

  it("prepares CO vs BB SRP with 100NL as rake structure (no range weights)", async () => {
    const proposal = await provider.interpret(
      request("Set up CO vs BB SRP with 100NL ranges"),
    );
    expect(proposal.kind).toBe("prepare_study");
    if (proposal.kind !== "prepare_study") return;
    expect(proposal.intent.mode).toBe("create");
    expect(proposal.intent.oopPosition).toBe("BB");
    expect(proposal.intent.ipPosition).toBe("CO");
    expect(proposal.intent.potType).toBe("SRP");
    expect(proposal.intent.stakesLabel).toBe("100NL");
    // Stack still omitted — resolve assumes 100bb; 100NL must not imply stack.
    expect(proposal.intent.stackBb).toBeUndefined();
    expect(proposal.selectedProfileId).toBe(fixture25Nl.id);
    const serialized = JSON.stringify(proposal);
    expect(serialized).not.toContain(fixture25Nl.ranges.oop);
    expect(serialized).not.toContain(fixture25Nl.ranges.ip);
    expect(serialized.length).toBeLessThan(2000);
  });

  it("omits rake/stack on the proposal when silent so resolve can assume cEV / 100bb", async () => {
    const proposal = await provider.interpret(
      request("Set up CO vs BB SRP"),
    );
    expect(proposal.kind).toBe("prepare_study");
    if (proposal.kind !== "prepare_study") return;
    // Silence defaults are applied in resolve, not invented as explicit request fields.
    expect(proposal.intent.stakesLabel).toBeUndefined();
    expect(proposal.intent.stackBb).toBeUndefined();
    expect(proposal.stakesLabel).toBeUndefined();
    expect(proposal.stackBb).toBeUndefined();
    expect(proposal.intent.potType).toBe("SRP");
    expect(proposal.selectedProfileId).toBe(fixture25.id);
  });

  it("clarifies when pot type / preflop action is missing", async () => {
    const proposal = await provider.interpret(
      request("Set up CO vs BB with 100NL ranges"),
    );
    expect(proposal.kind).toBe("clarify");
    if (proposal.kind !== "clarify") return;
    expect(proposal.questions[0]).toMatch(/pot type|SRP|3BP|4BP/i);
  });

  it("does not treat “my 100NL profile” as a personal profile without pot type", async () => {
    const proposal = await provider.interpret(
      request("Set up CO vs BB using my 100NL profile"),
    );
    expect(proposal.kind).toBe("clarify");
    if (proposal.kind !== "clarify") return;
    expect(proposal.questions[0]).toMatch(/pot type|SRP|3BP|4BP/i);
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

  it("clarifies rake-only requests and does not invent stack from 100NL", async () => {
    const proposal = await provider.interpret(request("100NL"));
    expect(proposal.kind).toBe("clarify");
    if (proposal.kind !== "clarify") return;
    expect(proposal.questions[0]).toMatch(/rake structure|stakes environment/i);
    expect(proposal.questions[0]).not.toMatch(/100bb/i);
  });

  it("is constructible via class export", () => {
    expect(new FakeAssistantProvider()).toBeInstanceOf(FakeAssistantProvider);
  });
});
