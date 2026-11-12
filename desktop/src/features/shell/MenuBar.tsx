import { useEffect, useRef, useState } from "react";
import {
  openSolutionFile,
  saveSolutionFileAs,
} from "../../commands/solutionFiles";
import { matchShortcut, SHORTCUTS } from "../../commands/shortcuts";
import {
  canExecuteCalculateEv,
  canExecuteCompareToBaseline,
  canExecuteContinue,
  canExecuteOpenLockEditor,
  canExecuteOpenStrategyEditor,
  canExecutePause,
  canExecuteResolveLocked,
  canExecuteSave,
  canExecuteSolve,
  canExecuteStop,
  executeCalculateEv,
  executeCompareToBaseline,
  executeContinue,
  executeOpenLockEditor,
  executeOpenStrategyEditor,
  executePause,
  executeResolveLocked,
  executeSave,
  executeSolve,
  executeStop,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface Props {
  workspace: WorkspaceId;
  onWorkspace: (id: WorkspaceId) => void;
  helpOpen: boolean;
  onHelpOpen: (open: boolean) => void;
  assistantOpen: boolean;
  onAssistantToggle: () => void;
}

type MenuId = "file" | "solve" | "tree" | "view" | null;

export function MenuBar({
  workspace,
  onWorkspace,
  helpOpen,
  onHelpOpen,
  assistantOpen,
  onAssistantToggle,
}: Props) {
  const [openMenu, setOpenMenu] = useState<MenuId>(null);
  const rootRef = useRef<HTMLElement>(null);

  const solve = useStudyStore((s) => s.solve);
  const continueSolve = useStudyStore((s) => s.continueSolve);
  const pause = useStudyStore((s) => s.pause);
  const stop = useStudyStore((s) => s.stop);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openSolution = useStudyStore((s) => s.openSolution);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const toggleTheme = useStudyStore((s) => s.toggleTheme);
  const resetLayout = useStudyStore((s) => s.resetLayout);
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const undoRange = useStudyStore((s) => s.undoRange);
  const redoRange = useStudyStore((s) => s.redoRange);
  const phase = useStudyStore((s) => s.phase);
  const draft = useStudyStore((s) => s.draft);
  const solutionId = useStudyStore((s) => s.solutionId);
  const storeWorkspace = useStudyStore((s) => s.workspace);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solveValidationErrors = useStudyStore((s) => s.solveValidationErrors);
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const setStrategyEditDrawerOpen = useStudyStore((s) => s.setStrategyEditDrawerOpen);
  const resolveLocked = useStudyStore((s) => s.resolveLocked);
  const loadCompare = useStudyStore((s) => s.loadCompare);
  const baselineSolutionId = useStudyStore((s) => s.baselineSolutionId);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const setHoverCell = useStudyStore((s) => s.setHoverCell);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const setSettingsOpen = useSettingsStore((s) => s.setSettingsOpen);

  function commandDeps() {
    return {
      getContext: () => studyCommandContextFromStore(useStudyStore.getState()),
    };
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = matchShortcut(event);
      if (!action) {
        return;
      }
      if (action === "escape") {
        if (settingsOpen) {
          setSettingsOpen(false);
        } else if (lockDrawerOpen) {
          setLockDrawerOpen(false);
        } else if (strategyEditDrawerOpen) {
          setStrategyEditDrawerOpen(false);
        } else if (helpOpen) {
          onHelpOpen(false);
        } else {
          setSelectedCell(null);
          setHoverCell(null);
        }
        event.preventDefault();
        return;
      }
      // Solver shortcuts must not fire from the Equity calculator workspace.
      if (workspace === "equity") {
        if (action === "solve" || action === "stop" || action === "continue") {
          return;
        }
      }
      if (action === "solve") {
        event.preventDefault();
        void executeSolve({ ...commandDeps(), solve });
      } else if (action === "stop") {
        event.preventDefault();
        void executeStop({ ...commandDeps(), stop });
      } else if (action === "continue") {
        event.preventDefault();
        void executeContinue({ ...commandDeps(), continueSolve });
      } else if (action === "help") {
        event.preventDefault();
        onHelpOpen(!helpOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    workspace,
    solve,
    stop,
    continueSolve,
    helpOpen,
    onHelpOpen,
    settingsOpen,
    setSettingsOpen,
    lockDrawerOpen,
    setLockDrawerOpen,
    strategyEditDrawerOpen,
    setStrategyEditDrawerOpen,
    setSelectedCell,
    setHoverCell,
  ]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const commandCtx = studyCommandContextFromStore({
    phase,
    draft,
    solutionId,
    workspace: storeWorkspace,
    currentNode,
    solveValidationErrors,
  });
  const solveGate = canExecuteSolve(commandCtx);
  const continueGate = canExecuteContinue(commandCtx);
  const pauseGate = canExecutePause(commandCtx);
  const stopGate = canExecuteStop(commandCtx);
  const saveGate = canExecuteSave(commandCtx);
  const evGate = canExecuteCalculateEv(commandCtx);
  const lockGate = canExecuteOpenLockEditor(commandCtx);
  const strategyGate = canExecuteOpenStrategyEditor(commandCtx);
  const resolveGate = canExecuteResolveLocked(commandCtx);
  const compareGate = canExecuteCompareToBaseline(commandCtx);
  const compareDisabled = !compareGate.ok || !baselineSolutionId;
  const compareTitle = !compareGate.ok
    ? compareGate.reason
    : !baselineSolutionId
      ? "Resolve locked first to create a baseline"
      : compareGate.reason;

  return (
    <header className="menu-bar" ref={rootRef}>
      <nav className="menu-bar__menus" aria-label="Application">
        <Menu
          id="file"
          label="File"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: "Open solution…",
              onClick: () => {
                void openSolutionFile({
                  getSolutionPath: () => useStudyStore.getState().draft.solutionPath,
                  updateDraft,
                  openSolution,
                  saveSolution,
                });
              },
            },
            {
              label: "Save solution…",
              disabled: !saveGate.ok,
              title: saveGate.reason,
              onClick: () => {
                void executeSave({
                  ...commandDeps(),
                  save: async () =>
                    saveSolutionFileAs({
                      getSolutionPath: () =>
                        useStudyStore.getState().draft.solutionPath,
                      updateDraft,
                      openSolution,
                      saveSolution,
                      confirmReplace: (path) =>
                        window.confirm(
                          `Save over "${path}"? An existing file at that path will be replaced.`,
                        ),
                    }),
                });
              },
            },
            { sep: true },
            { label: "Undo range", onClick: () => undoRange() },
            { label: "Redo range", onClick: () => redoRange() },
          ]}
        />
        <Menu
          id="solve"
          label="Solve"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: "Solve",
              shortcut: "S",
              onClick: () => void executeSolve({ ...commandDeps(), solve }),
              disabled: !solveGate.ok,
              title: solveGate.reason,
            },
            {
              label: "Continue",
              shortcut: "C",
              onClick: () =>
                void executeContinue({ ...commandDeps(), continueSolve }),
              disabled: !continueGate.ok,
              title: continueGate.reason,
            },
            {
              label: "Pause",
              onClick: () => void executePause({ ...commandDeps(), pause }),
              disabled: !pauseGate.ok,
              title: pauseGate.reason,
            },
            {
              label: "Stop",
              shortcut: "X",
              onClick: () => void executeStop({ ...commandDeps(), stop }),
              disabled: !stopGate.ok,
              title: stopGate.reason,
            },
            { sep: true },
            {
              label: "Calculate EV",
              onClick: () =>
                void executeCalculateEv({ ...commandDeps(), calculateEv }),
              disabled: !evGate.ok,
              title: evGate.reason,
            },
            { sep: true },
            {
              label: "Resolve locked",
              onClick: () =>
                void executeResolveLocked({
                  ...commandDeps(),
                  resolveLocked,
                }),
              disabled: !resolveGate.ok,
              title: resolveGate.reason,
            },
            {
              label: "Compare to baseline",
              onClick: () =>
                void executeCompareToBaseline({
                  ...commandDeps(),
                  loadCompare,
                }),
              disabled: compareDisabled,
              title: compareTitle,
            },
          ]}
        />
        <Menu
          id="tree"
          label="Tree"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: "Node locking…",
              onClick: () =>
                executeOpenLockEditor({ ...commandDeps(), setLockDrawerOpen }),
              disabled: !lockGate.ok,
              title: lockGate.reason,
            },
            {
              label: "Open strategy editor",
              onClick: () =>
                executeOpenStrategyEditor({
                  ...commandDeps(),
                  setStrategyEditDrawerOpen,
                }),
              disabled: !strategyGate.ok,
              title: strategyGate.reason,
            },
            {
              label: "Resolve locked",
              onClick: () =>
                void executeResolveLocked({
                  ...commandDeps(),
                  resolveLocked,
                }),
              disabled: !resolveGate.ok,
              title: resolveGate.reason,
            },
            {
              label: "Compare to baseline",
              onClick: () =>
                void executeCompareToBaseline({
                  ...commandDeps(),
                  loadCompare,
                }),
              disabled: compareDisabled,
              title: compareTitle,
            },
          ]}
        />
        <Menu
          id="view"
          label="View"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: layout.lowerDock ? "Hide lower dock" : "Show lower dock",
              onClick: () => setLayout({ lowerDock: !layout.lowerDock }),
            },
            {
              label: layout.dualRange ? "Single matrix" : "Dual range layout",
              onClick: () => setLayout({ dualRange: !layout.dualRange }),
            },
            { label: "Reset layout", onClick: () => resetLayout() },
          ]}
        />
      </nav>
      <div className="menu-bar__center">
        <button
          type="button"
          className="menu-bar__assistant"
          aria-pressed={assistantOpen}
          onClick={onAssistantToggle}
        >
          Assistant
        </button>
        <WorkspaceSwitcher workspace={workspace} onChange={onWorkspace} />
        <span className="menu-bar__assistant menu-bar__center-balance" aria-hidden="true">
          Assistant
        </span>
      </div>
      <div className="menu-bar__actions">
        <button type="button" className="icon-btn" onClick={() => toggleTheme()} title="Theme">
          Theme
        </button>
        <button
          type="button"
          className="icon-btn menu-bar__gear"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.22-1.14.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.49.4 1.04.72 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.22 1.14-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  );
}

interface MenuItem {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip / native title — especially useful when disabled. */
  title?: string;
  sep?: boolean;
}

function Menu({
  id,
  label,
  open,
  setOpen,
  items,
}: {
  id: Exclude<MenuId, null>;
  label: string;
  open: MenuId;
  setOpen: (id: MenuId) => void;
  items: MenuItem[];
}) {
  const isOpen = open === id;
  return (
    <div className="menu-root" data-open={isOpen}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setOpen(isOpen ? null : id)}
        onMouseEnter={() => {
          if (open) {
            setOpen(id);
          }
        }}
      >
        {label}
      </button>
      {isOpen ? (
        <div className="menu-dropdown" role="menu">
          {items.map((item, index) =>
            item.sep ? (
              <div key={`sep-${index}`} className="menu-sep" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(null);
                  item.onClick?.();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut ? <span className="shortcut">{item.shortcut}</span> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) {
    return null;
  }
  return (
    <div className="help-overlay" role="dialog" aria-label="Keyboard shortcuts">
      <div className="help-panel">
        <h2>Keyboard shortcuts</h2>
        <ul>
          {SHORTCUTS.map((entry) => (
            <li key={entry.key}>
              <kbd>{entry.key}</kbd> {entry.label}
            </li>
          ))}
        </ul>
        <p className="muted" style={{ marginTop: 12 }}>
          Shortcuts are ignored while typing in a field.
        </p>
        <div style={{ marginTop: 12, textAlign: "right" }}>
          <button type="button" className="toolbar-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
