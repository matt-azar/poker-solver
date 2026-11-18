import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useState } from "react";
import { useMatrixKeyboard, type MatrixFocusCell } from "./useMatrixKeyboard";

function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent<HTMLElement>;
}

describe("useMatrixKeyboard", () => {
  it("moves focus by rank and pins with Enter; Escape clears", () => {
    const setSelectedCell = vi.fn();
    const { result } = renderHook(() => {
      const [focusCell, setFocusCell] = useState<MatrixFocusCell | null>({
        row: 1,
        col: 1,
        text: "KK",
      });
      const keyboard = useMatrixKeyboard({
        selectedCell: null,
        setSelectedCell,
        focusCell,
        setFocusCell,
      });
      return { keyboard, focusCell };
    });

    act(() => {
      result.current.keyboard.onGridKeyDown(keyEvent("ArrowRight"));
    });
    expect(result.current.focusCell).toEqual(
      expect.objectContaining({ row: 1, col: 2 }),
    );

    act(() => {
      result.current.keyboard.onGridKeyDown(keyEvent("Enter"));
    });
    expect(setSelectedCell).toHaveBeenCalledWith(
      expect.objectContaining({ row: 1, col: 2 }),
    );

    act(() => {
      result.current.keyboard.onGridKeyDown(keyEvent("Escape"));
    });
    expect(setSelectedCell).toHaveBeenCalledWith(null);
    expect(result.current.focusCell).toBeNull();
  });
});
