import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_DEMO_LAYOUT_MQ, syncPublicDemoDocumentAttrs } from "./phoneLayout";

describe("phoneLayout", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-public-demo");
    document.documentElement.removeAttribute("data-phone-demo");
  });

  it("exports a media query covering phone portrait widths", () => {
    expect(PHONE_DEMO_LAYOUT_MQ).toContain("max-width: 540px");
  });

  it("syncs document markers for CSS", () => {
    syncPublicDemoDocumentAttrs({ demoActive: true, phoneLayout: true });
    expect(document.documentElement.getAttribute("data-public-demo")).toBe(
      "true",
    );
    expect(document.documentElement.getAttribute("data-phone-demo")).toBe(
      "true",
    );

    syncPublicDemoDocumentAttrs({ demoActive: true, phoneLayout: false });
    expect(document.documentElement.getAttribute("data-public-demo")).toBe(
      "true",
    );
    expect(document.documentElement.hasAttribute("data-phone-demo")).toBe(
      false,
    );

    syncPublicDemoDocumentAttrs({ demoActive: false, phoneLayout: false });
    expect(document.documentElement.hasAttribute("data-public-demo")).toBe(
      false,
    );
  });

  it("matchMedia stub can report phone layout", () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("max-width: 540px"),
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener(_type: string, listener: () => void) {
            listeners.add(listener);
          },
          removeEventListener(_type: string, listener: () => void) {
            listeners.delete(listener);
          },
          dispatchEvent() {
            return false;
          },
        }) as MediaQueryList,
    );
    expect(window.matchMedia(PHONE_DEMO_LAYOUT_MQ).matches).toBe(true);
    vi.unstubAllGlobals();
  });
});
