import { useEffect, useRef, useState } from "react";
import {
  openSolutionFile,
  saveSolutionFileAs,
} from "../../commands/solutionFiles";
import { matchShortcut, SHORTCUTS } from "../../commands/shortcuts";
import {
  canExecuteCalculateEv,
  canExecuteContinue,
  canExecuteOpenLockEditor,
  canExecuteOpenStrategyEditor,
  canExecutePause,
  canExecuteSave,
  canExecuteSolve,
  canExecuteStop,
  executeCalculateEv,
  executeContinue,
  executeOpenLockEditor,
  executeOpenStrategyEditor,
  executePause,
  executeSave,
  executeSolve,
  executeStop,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import type { ThemePreference } from "../../domain/types";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { WORKSPACES, WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface Props {
  workspace: WorkspaceId;
  onWorkspace: (id: WorkspaceId) => void;
  helpOpen: boolean;
  onHelpOpen: (open: boolean) => void;
  assistantOpen: boolean;
  onAssistantToggle: () => void;
}

type MenuId = "file" | "solve" | "tree" | "view" | "workspace" | "settings" | null;

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
  const themePreference = useStudyStore((s) => s.themePreference);
  const setThemePreference = useStudyStore((s) => s.setThemePreference);
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
  const updateSettings = useSettingsStore((s) => s.updateSettings);

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

  return (
    <header className="menu-bar" ref={rootRef}>
      <div className="menu-bar__brand">Hold&apos;em Study</div>
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
              onClick: () => {
                void executeSave({
                  ...commandDeps(),
                  save: async () => {
                    await saveSolutionFileAs({
                      getSolutionPath: () =>
                        useStudyStore.getState().draft.solutionPath,
                      updateDraft,
                      openSolution,
                      saveSolution,
                    });
                  },
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
            },
            {
              label: "Continue",
              shortcut: "C",
              onClick: () =>
                void executeContinue({ ...commandDeps(), continueSolve }),
              disabled: !continueGate.ok,
            },
            {
              label: "Pause",
              onClick: () => void executePause({ ...commandDeps(), pause }),
              disabled: !pauseGate.ok,
            },
            {
              label: "Stop",
              shortcut: "X",
              onClick: () => void executeStop({ ...commandDeps(), stop }),
              disabled: !stopGate.ok,
            },
            { sep: true },
            {
              label: "Calculate EV",
              onClick: () =>
                void executeCalculateEv({ ...commandDeps(), calculateEv }),
              disabled: !evGate.ok,
            },
            { sep: true },
            {
              label: "Resolve locked",
              onClick: () => void resolveLocked(),
            },
            {
              label: "Compare to baseline",
              onClick: () => void loadCompare(),
              disabled: !baselineSolutionId,
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
              label: "Open lock editor",
              onClick: () =>
                executeOpenLockEditor({ ...commandDeps(), setLockDrawerOpen }),
              disabled: !lockGate.ok,
            },
            {
              label: "Open strategy editor",
              onClick: () =>
                executeOpenStrategyEditor({
                  ...commandDeps(),
                  setStrategyEditDrawerOpen,
                }),
              disabled: !strategyGate.ok,
            },
            {
              label: "Resolve locked",
              onClick: () => void resolveLocked(),
            },
            {
              label: "Compare to baseline",
              onClick: () => void loadCompare(),
              disabled: !baselineSolutionId,
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
        <Menu
          id="workspace"
          label="Workspace"
          open={openMenu}
          setOpen={setOpenMenu}
          items={WORKSPACES.map((entry) => ({
            label: entry.label,
            onClick: () => onWorkspace(entry.id),
            disabled: workspace === entry.id,
          }))}
        />
        <Menu
          id="settings"
          label="Settings"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: "Open settings…",
              onClick: () => setSettingsOpen(true),
            },
            { sep: true },
            {
              label: `Theme: ${themePreference}`,
              onClick: () => {
                const order: ThemePreference[] = ["system", "light", "dark"];
                const current = (["system", "light", "dark"] as const).includes(
                  themePreference as ThemePreference,
                )
                  ? (themePreference as ThemePreference)
                  : "system";
                const next = order[(order.indexOf(current) + 1) % order.length];
                setThemePreference(next);
                updateSettings({ themePreference: next });
              },
            },
            {
              label: "Toggle light/dark",
              onClick: () => toggleTheme(),
            },
          ]}
        />
        <button
          type="button"
          className="menu-bar__assistant"
          aria-pressed={assistantOpen}
          onClick={onAssistantToggle}
        >
          Assistant
        </button>
      </nav>
      <WorkspaceSwitcher workspace={workspace} onChange={onWorkspace} />
      <div className="menu-bar__spacer" />
      <div className="menu-bar__actions">
        <button type="button" className="icon-btn" onClick={() => toggleTheme()} title="Theme">
          Theme
        </button>
      </div>
    </header>
  );
}

interface MenuItem {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
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
