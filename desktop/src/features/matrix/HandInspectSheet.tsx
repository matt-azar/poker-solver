/**
 * Phone-demo hand inspection: ComboInspector in a dismissible bottom sheet.
 * Reuses studyStore selectedCell; close clears selection and keeps matrix/node/scroll.
 */
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePhoneDemoLayout } from "../../demo/phoneLayout";
import { useStudyStore } from "../../state/studyStore";
import { ComboInspector } from "./ComboInspector";

export function HandInspectSheet() {
  const phoneLayout = usePhoneDemoLayout();
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const open = phoneLayout && selectedCell != null;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Focus the visible close control after paint.
    const id = window.requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(id);
      document.body.style.overflow = overflow;
      const restore = previouslyFocused.current;
      if (restore && document.contains(restore)) {
        restore.focus();
      }
    };
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  function dismiss() {
    setSelectedCell(null);
  }

  function onBackdropClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      dismiss();
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
    }
  }

  return createPortal(
    <div
      className="hand-inspect-sheet"
      role="presentation"
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        className="hand-inspect-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="hand-inspect-sheet__chrome">
          <h2 id={titleId} className="hand-inspect-sheet__title">
            Hands
            {selectedCell?.text ? (
              <span className="hand-inspect-sheet__hand tabular">
                {" "}
                {selectedCell.text}
              </span>
            ) : null}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="toolbar-btn hand-inspect-sheet__close"
            aria-label="Close hand inspector"
            onClick={dismiss}
          >
            Close
          </button>
        </div>
        <div className="hand-inspect-sheet__body">
          <ComboInspector />
        </div>
      </div>
    </div>,
    document.body,
  );
}
