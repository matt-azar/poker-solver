import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HELP_CHAT_LAYOUT,
  useHelpChatStore,
} from "./helpChatStore";

describe("helpChatStore", () => {
  beforeEach(() => {
    localStorage.removeItem("holdem-study-help-chat-v1");
    useHelpChatStore.getState().resetLayout();
  });

  it("starts hidden with default geometry", () => {
    const { layout } = useHelpChatStore.getState();
    expect(layout.visible).toBe(false);
    expect(layout.width).toBe(DEFAULT_HELP_CHAT_LAYOUT.width);
    expect(layout.height).toBe(DEFAULT_HELP_CHAT_LAYOUT.height);
  });

  it("persists visibility and position", () => {
    useHelpChatStore.getState().setVisible(true);
    useHelpChatStore.getState().setPosition(40, 80);
    useHelpChatStore.getState().setSize(400, 500);
    const raw = localStorage.getItem("holdem-study-help-chat-v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(String(raw)) as {
      visible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(parsed.visible).toBe(true);
    expect(parsed.x).toBe(40);
    expect(parsed.y).toBe(80);
    expect(parsed.width).toBe(400);
    expect(parsed.height).toBe(500);
  });

  it("clamps undersized windows up to the minimum", () => {
    useHelpChatStore.getState().setSize(100, 50);
    const { layout } = useHelpChatStore.getState();
    expect(layout.width).toBeGreaterThanOrEqual(280);
    expect(layout.height).toBeGreaterThanOrEqual(240);
  });
});
