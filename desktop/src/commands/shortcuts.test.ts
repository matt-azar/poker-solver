import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcuts";

function keyEvent(
  key: string,
  init: Partial<KeyboardEvent> & { target?: EventTarget | null } = {},
): KeyboardEvent {
  const { target = document.body, ...rest } = init;
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...rest,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("matchShortcut", () => {
  it("matches Escape regardless of key casing", () => {
    expect(matchShortcut(keyEvent("Escape"))).toBe("escape");
    expect(matchShortcut(keyEvent("escape"))).toBe("escape");
    expect(matchShortcut(keyEvent("ESCAPE"))).toBe("escape");
  });

  it("matches Escape even when focus is in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(matchShortcut(keyEvent("Escape", { target: input }))).toBe("escape");
    input.remove();
  });

  it("still matches letter shortcuts case-insensitively", () => {
    expect(matchShortcut(keyEvent("s"))).toBe("solve");
    expect(matchShortcut(keyEvent("S"))).toBe("solve");
    expect(matchShortcut(keyEvent("x"))).toBe("stop");
  });

  it("ignores letter shortcuts while typing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(matchShortcut(keyEvent("s", { target: input }))).toBeNull();
    input.remove();
  });

  it("ignores modified Escape/chord keys", () => {
    expect(matchShortcut(keyEvent("Escape", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(keyEvent("Escape", { metaKey: true }))).toBeNull();
    expect(matchShortcut(keyEvent("Escape", { altKey: true }))).toBeNull();
  });
});
