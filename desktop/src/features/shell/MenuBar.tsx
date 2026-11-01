import { useEffect, useRef, useState } from "react";
import { matchShortcut, SHORTCUTS } from "../../commands/shortcuts";
import { solveControlFlags } from "../../domain/solveControls";
import type { ThemePreference } from "../../domain/types";
import { getPlatform } from "../../platform/browser";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface Props {
  workspace: WorkspaceId;
  onWorkspace: (id: WorkspaceId) => void;
  helpOpen: boolean;
  onHelpOpen: (open: boolean) => void;
  /** Show the persistent Help chat window (does not close shortcuts overlay). */
  onHelpChatOpen: () => void;
}

type MenuId = "file" | "solve" | "tree" | "view" | "help" | null;

export function MenuBar({
  workspace,
  onWorkspace,
  helpOpen,
  onHelpOpen,
  onHelpChatOpen,
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
  const draftPath = useStudyStore((s) => s.draft.solutionPath);
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
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const setStrategyEditDrawerOpen = useStudyStore((s) => s.setStrategyEditDrawerOpen);
  const resolveLocked = useStudyStore((s) => s.resolveLocked);
  const loadCompare = useStudyStore((s) => s.loadCompare);
  const baselineSolutionId = useStudyStore((s) => s.baselineSolutionId);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const setHoverCell = useStudyStore((s) => s.setHoverCell);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = matchShortcut(event);
      if (!action) {
        return;
      }
      if (action === "escape") {
        if (lockDrawerOpen) {
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
      const flags = solveControlFlags(useStudyStore.getState().phase);
      if (action === "solve") {
        if (!flags.canSolve) {
          return;
        }
        event.preventDefault();
        void solve();
      } else if (action === "stop") {
        if (!flags.canStop) {
          return;
        }
        event.preventDefault();
        void stop();
      } else if (action === "continue") {
        if (!flags.canContinue) {
          return;
        }
        event.preventDefault();
        void continueSolve();
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

  const { canSolve, canContinue, canPause, canStop } = solveControlFlags(phase);

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
                void (async () => {
                  const path = await getPlatform().pickOpenPath();
                  if (path) {
                    updateDraft({ solutionPath: path });
                    await openSolution(path);
                  }
                })();
              },
            },
            {
              label: "Save solution…",
              onClick: () => {
                void (async () => {
                  const path = await getPlatform().pickSavePath(draftPath);
                  if (path) {
                    updateDraft({ solutionPath: path });
                    await saveSolution();
                  }
                })();
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
              onClick: () => void solve(),
              disabled: !canSolve,
            },
            {
              label: "Continue",
              shortcut: "C",
              onClick: () => void continueSolve(),
              disabled: !canContinue,
            },
            { label: "Pause", onClick: () => void pause(), disabled: !canPause },
            {
              label: "Stop",
              shortcut: "X",
              onClick: () => void stop(),
              disabled: !canStop,
            },
            { sep: true },
            { label: "Calculate EV", onClick: () => void calculateEv() },
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
              onClick: () => setLockDrawerOpen(true),
            },
            {
              label: "Open strategy editor",
              onClick: () => setStrategyEditDrawerOpen(true),
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
            { label: "Toggle theme", onClick: () => toggleTheme() },
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
              },
            },
            { sep: true },
            {
              label: layout.leftNav ? "Hide navigator" : "Show navigator",
              onClick: () => setLayout({ leftNav: !layout.leftNav }),
            },
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
          id="help"
          label="Help"
          open={openMenu}
          setOpen={setOpenMenu}
          items={[
            {
              label: "Study assistant…",
              onClick: () => onHelpChatOpen(),
            },
            {
              label: "Keyboard shortcuts",
              shortcut: "?",
              onClick: () => onHelpOpen(true),
            },
          ]}
        />
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
