import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlayingCard } from "./PlayingCard";

describe("PlayingCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders rank with a suit symbol and suit data attribute", () => {
    render(<PlayingCard card="Ah" />);
    const face = screen.getByLabelText("A♥");
    expect(face.getAttribute("data-suit")).toBe("h");
    expect(face.textContent).toContain("A");
    expect(face.textContent).toContain("♥");
  });

  it("renders an empty interactive street slot", () => {
    render(<PlayingCard interactive emptyLabel="T" />);
    const button = screen.getByRole("button", { name: "T" });
    expect(button.getAttribute("data-empty")).toBe("true");
  });
});
