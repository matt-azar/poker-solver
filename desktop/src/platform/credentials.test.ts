import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_OPENAI_STORAGE_KEY,
  clearAssistantOpenAiCredential,
  getAssistantOpenAiCredential,
  hasAssistantOpenAiCredential,
  setAssistantOpenAiCredential,
} from "./credentials";

describe("assistant credentials (browser path)", () => {
  afterEach(() => {
    localStorage.removeItem(BROWSER_OPENAI_STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it("reads and writes the browser prototype key without embedding secrets", async () => {
    expect(await hasAssistantOpenAiCredential()).toBe(false);
    const source = await setAssistantOpenAiCredential(" sk-test-key ");
    expect(source).toBe("localStorage");
    expect(localStorage.getItem(BROWSER_OPENAI_STORAGE_KEY)).toBe("sk-test-key");
    const lookup = await getAssistantOpenAiCredential();
    expect(lookup).toEqual({ value: "sk-test-key", source: "localStorage" });
    expect(await hasAssistantOpenAiCredential()).toBe(true);
    await clearAssistantOpenAiCredential();
    expect(await hasAssistantOpenAiCredential()).toBe(false);
  });

  it("rejects empty credentials", async () => {
    await expect(setAssistantOpenAiCredential("   ")).rejects.toThrow(/non-empty/i);
  });
});
