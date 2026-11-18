/**
 * In-app solutions catalogue — folders + named .psol entries.
 * Primary Save/Open UX (no OS file dialog). Browse disk remains secondary.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  buildSolutionsTree,
  getSolutionsCatalogue,
  UNFILED_FOLDER,
  type SavedSolution,
  type SolutionsTreeNode,
} from "../../domain/solutionsCatalogue";
import { resolveCatalogueSavePath } from "../../domain/solutionsRoot";
import { openSolutionFile, saveSolutionFileAs } from "../../commands/solutionFiles";
import { trainerContinueFromStatus } from "../../commands/studyCommands";
import { useStudyStore } from "../../state/studyStore";
import type { SolutionsCatalogueMode } from "../../state/solutionsCatalogueUi";

export type CatalogueSaveKind = "study" | "checkpoint";

export interface SolutionsCatalogueProps {
  mode: SolutionsCatalogueMode;
  onClose: () => void;
}

function FolderIcon() {
  return (
    <svg className="seat-tree__glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M1.5 3.25A1.75 1.75 0 0 1 3.25 1.5h3.1c.4 0 .78.16 1.06.44l.8.8c.14.14.33.22.53.22h4.01A1.75 1.75 0 0 1 14.5 4.7v7.05A1.75 1.75 0 0 1 12.75 13.5h-9.5A1.75 1.75 0 0 1 1.5 11.75V3.25Z"
        opacity="0.92"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="seat-tree__glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M3.5 1.5h5.3L12.5 5.2V14a.75.75 0 0 1-.75.75h-8.5A.75.75 0 0 1 2.5 14V2.25c0-.41.34-.75.75-.75Zm5 .7V5h2.7L8.5 2.2Z"
        opacity="0.88"
      />
    </svg>
  );
}

function depthStyle(depth: number): CSSProperties {
  return { ["--seat-tree-depth" as string]: String(depth) };
}

function RowMenu({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className="seat-tree__menu" ref={rootRef}>
      <button
        type="button"
        className="seat-tree__menu-trigger"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(!open);
        }}
      >
        ⋯
      </button>
      {open ? (
        <div
          className="seat-tree__menu-panel"
          role="menu"
          aria-label={`Actions for ${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function menuItem(
  label: string,
  onClick: () => void,
  options?: { danger?: boolean; title?: string },
) {
  return (
    <button
      type="button"
      role="menuitem"
      className={
        options?.danger
          ? "seat-tree__menu-item seat-tree__menu-item--danger"
          : "seat-tree__menu-item"
      }
      title={options?.title}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

function promptLabel(message: string, initial: string): string | null {
  const next = window.prompt(message, initial);
  if (next == null) {
    return null;
  }
  const trimmed = next.trim();
  return trimmed || null;
}

export function SolutionsCatalogue({ mode, onClose }: SolutionsCatalogueProps) {
  const catalogue = getSolutionsCatalogue();
  const solutionId = useStudyStore((s) => s.solutionId);
  const status = useStudyStore((s) => s.status);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openSolution = useStudyStore((s) => s.openSolution);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const loadRecent = useStudyStore((s) => s.loadRecent);
  const canSaveCheckpoint = trainerContinueFromStatus(status) === true;

  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveFolder, setSaveFolder] = useState(UNFILED_FOLDER);
  const [saveKind, setSaveKind] = useState<CatalogueSaveKind>("study");
  const [newFolder, setNewFolder] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [highlightSave, setHighlightSave] = useState(mode === "save");

  useEffect(() => {
    if (!canSaveCheckpoint && saveKind === "checkpoint") {
      setSaveKind("study");
    }
  }, [canSaveCheckpoint, saveKind]);

  const folders = useMemo(() => {
    void revision;
    return catalogue.listFolders();
  }, [catalogue, revision]);

  const tree = useMemo(() => {
    void revision;
    return buildSolutionsTree(catalogue.listFolders(), catalogue.list());
  }, [catalogue, revision]);

  const refresh = () => setRevision((value) => value + 1);

  const afterMutation = () => {
    refresh();
    void loadRecent();
  };

  const commitSave = async (replaceId?: string) => {
    const name = saveName.trim();
    if (!name) {
      setError("Enter a name for the saved solution.");
      return;
    }
    if (!solutionId) {
      setError("Solve or open a solution before saving.");
      return;
    }
    const studyOnly = saveKind !== "checkpoint";
    if (!studyOnly && !canSaveCheckpoint) {
      setError("Continue checkpoint needs trainer state.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveCatalogueSavePath(saveFolder, name);
      if (!resolved.ok) {
        setError(resolved.error);
        return;
      }
      const saved = await saveSolution(resolved.path, { studyOnly });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      const indexed = catalogue.save(name, saved.path, {
        folder: saveFolder,
        replaceId,
      });
      if (!indexed.ok) {
        if (
          indexed.reason === "name_collision" &&
          indexed.collidingId &&
          !replaceId
        ) {
          const replace = window.confirm(
            `${indexed.error} Replace it with this solution?`,
          );
          if (replace) {
            await commitSave(indexed.collidingId);
          }
          return;
        }
        setError(indexed.error);
        return;
      }
      setSaveName("");
      setHighlightSave(false);
      afterMutation();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const openEntry = async (entry: SavedSolution) => {
    setBusy(true);
    setError(null);
    try {
      const result = await openSolution(entry.path);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      afterMutation();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const addFolder = () => {
    const base = saveFolder ? `${saveFolder}/${newFolder}` : newFolder;
    const result = catalogue.addFolder(base);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNewFolder("");
    setSaveFolder(result.folder);
    setError(null);
    afterMutation();
  };

  const renameEntry = (entry: SavedSolution) => {
    const name = promptLabel(`Rename "${entry.displayName}"`, entry.displayName);
    if (!name) {
      return;
    }
    const result = catalogue.rename(entry.id, name);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setOpenMenuId(null);
    afterMutation();
  };

  const deleteEntry = (entry: SavedSolution) => {
    if (!window.confirm(`Remove "${entry.displayName}" from the catalogue?`)) {
      return;
    }
    const result = catalogue.remove(entry.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setOpenMenuId(null);
    afterMutation();
  };

  const renameFolder = (folder: string, label: string) => {
    if (folder === UNFILED_FOLDER) {
      return;
    }
    const next = promptLabel(`Rename folder "${label}"`, label);
    if (!next) {
      return;
    }
    const parent = folder.includes("/")
      ? folder.slice(0, folder.lastIndexOf("/"))
      : "";
    const target = parent ? `${parent}/${next}` : next;
    const result = catalogue.renameFolder(folder, target);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (saveFolder === folder || saveFolder.startsWith(`${folder}/`)) {
      setSaveFolder(result.folder);
    }
    setError(null);
    setOpenMenuId(null);
    afterMutation();
  };

  const deleteFolder = (folder: string) => {
    if (folder === UNFILED_FOLDER) {
      return;
    }
    const result = catalogue.removeFolder(folder);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (saveFolder === folder || saveFolder.startsWith(`${folder}/`)) {
      setSaveFolder(UNFILED_FOLDER);
    }
    setError(null);
    setOpenMenuId(null);
    afterMutation();
  };

  const browseDiskOpen = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await openSolutionFile({
        getSolutionPath: () => useStudyStore.getState().draft.solutionPath,
        updateDraft,
        openSolution,
        saveSolution,
      });
      if (!result.ok) {
        if (result.cancelled) {
          return;
        }
        setError(result.error);
        return;
      }
      // Index disk opens under Unfiled when not already catalogued.
      if (!catalogue.findByPath(result.path)) {
        const base =
          result.path.split(/[/\\]/).pop()?.replace(/\.psol$/i, "") || "Solution";
        catalogue.save(base, result.path, { folder: UNFILED_FOLDER });
      }
      afterMutation();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const browseDiskSave = async () => {
    const studyOnly = saveKind !== "checkpoint";
    if (!studyOnly && !canSaveCheckpoint) {
      setError("Continue checkpoint needs trainer state.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await saveSolutionFileAs({
        getSolutionPath: () => useStudyStore.getState().draft.solutionPath,
        updateDraft,
        openSolution,
        saveSolution,
        saveOptions: { studyOnly },
        confirmReplace: (path) =>
          window.confirm(
            `Save over "${path}"? An existing file at that path will be replaced.`,
          ),
      });
      if (!result.ok) {
        if (result.cancelled) {
          return;
        }
        setError(result.error);
        return;
      }
      const base =
        result.path.split(/[/\\]/).pop()?.replace(/\.psol$/i, "") || "Solution";
      const existing = catalogue.findByPath(result.path);
      catalogue.save(base, result.path, {
        folder: existing?.folder ?? UNFILED_FOLDER,
        replaceId: existing?.id,
      });
      afterMutation();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const renderNodes = (nodes: SolutionsTreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      if (node.kind === "folder") {
        const menuOpen = openMenuId === node.id;
        return (
          <li key={node.id} className="seat-tree__node seat-tree__node--branch">
            <details className="seat-tree__branch" open>
              <summary className="seat-tree__row" style={depthStyle(depth)}>
                <span className="seat-tree__row-main">
                  <span className="seat-tree__twist" aria-hidden="true" />
                  <FolderIcon />
                  <span className="seat-tree__name seat-tree__branch-label">
                    {node.name}
                  </span>
                </span>
                <div className="seat-tree__row-actions">
                  <button
                    type="button"
                    className="toolbar-btn"
                    title="Save into this folder"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSaveFolder(node.folder);
                      setHighlightSave(true);
                      setError(null);
                    }}
                  >
                    Save here
                  </button>
                  {node.folder !== UNFILED_FOLDER ? (
                    <RowMenu
                      label={node.name}
                      open={menuOpen}
                      onOpenChange={(open) =>
                        setOpenMenuId(open ? node.id : null)
                      }
                    >
                      {menuItem("Rename", () =>
                        renameFolder(node.folder, node.name),
                      )}
                      {menuItem(
                        "Delete folder",
                        () => deleteFolder(node.folder),
                        { danger: true },
                      )}
                    </RowMenu>
                  ) : null}
                </div>
              </summary>
              {node.children.length > 0 ? (
                <ul className="seat-tree__list">
                  {renderNodes(node.children, depth + 1)}
                </ul>
              ) : (
                <p className="empty-hint seat-tree__unfiled-hint">Empty folder</p>
              )}
            </details>
          </li>
        );
      }

      const menuOpen = openMenuId === node.id;
      return (
        <li key={node.id} className="seat-tree__node seat-tree__node--leaf">
          <div className="seat-tree__row" style={depthStyle(depth)}>
            <button
              type="button"
              className="seat-tree__row-main seat-tree__open"
              disabled={busy}
              onClick={() => void openEntry(node.entry)}
              title={node.entry.path}
            >
              <span className="seat-tree__twist seat-tree__twist--leaf" aria-hidden="true" />
              <FileIcon />
              <span className="seat-tree__name">{node.entry.displayName}</span>
            </button>
            <div className="seat-tree__row-actions">
              <button
                type="button"
                className="toolbar-btn primary"
                disabled={busy}
                onClick={() => void openEntry(node.entry)}
              >
                Open
              </button>
              <RowMenu
                label={node.entry.displayName}
                open={menuOpen}
                onOpenChange={(open) => setOpenMenuId(open ? node.id : null)}
              >
                {menuItem("Rename", () => renameEntry(node.entry))}
                {menuItem("Delete", () => deleteEntry(node.entry), {
                  danger: true,
                })}
              </RowMenu>
            </div>
          </div>
        </li>
      );
    });

  return (
    <div className="tree-catalogue solutions-catalogue" aria-label="Solutions catalogue">
      <section className="seat-tree__toolbar" aria-label="Catalogue folders">
        <div className="seat-tree__save-form">
          <label>
            New folder
            <input
              value={newFolder}
              placeholder={
                saveFolder ? `under ${saveFolder} (e.g. 100bb)` : "e.g. SRP"
              }
              onChange={(event) => {
                setNewFolder(event.target.value);
                setError(null);
              }}
              aria-label="New folder name"
            />
          </label>
          <button type="button" className="toolbar-btn" onClick={addFolder}>
            Add folder
          </button>
        </div>
      </section>

      <div className="seat-tree__browser" aria-label="Saved solutions">
        <div className="seat-tree__browser-head">
          <h3 className="seat-tree__section-title">Saved solutions</h3>
        </div>
        {tree.length === 0 ? (
          <p className="empty-hint">No saved solutions yet.</p>
        ) : (
          <ul className="seat-tree__list">{renderNodes(tree, 0)}</ul>
        )}
      </div>

      <section
        className={
          highlightSave || mode === "save"
            ? "tree-catalogue__save tree-catalogue__save--focus"
            : "tree-catalogue__save"
        }
        aria-label="Save current solution"
      >
        <h3 className="tree-catalogue__title">Save current solution</h3>
        <div className="tree-catalogue__save-form">
          <label>
            Folder
            <select
              value={saveFolder}
              onChange={(event) => setSaveFolder(event.target.value)}
              aria-label="Folder for saved solution"
            >
              <option value={UNFILED_FOLDER}>Unfiled</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={saveName}
              placeholder="e.g. SRP flop probe"
              onChange={(event) => {
                setSaveName(event.target.value);
                setError(null);
              }}
              aria-label="Name for saved solution"
              autoFocus={mode === "save"}
            />
          </label>
          <label>
            Mode
            <select
              value={saveKind}
              onChange={(event) => {
                setSaveKind(event.target.value as CatalogueSaveKind);
                setError(null);
              }}
              aria-label="Save mode"
            >
              <option value="study">Study</option>
              <option value="checkpoint" disabled={!canSaveCheckpoint}>
                Continue
              </option>
            </select>
          </label>
          <button
            type="button"
            className="toolbar-btn primary"
            disabled={busy || !solutionId}
            title={!solutionId ? "Solve or open a solution first" : undefined}
            onClick={() => void commitSave()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {error ? (
        <p className="tree-catalogue__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="tree-catalogue__footer">
        <button
          type="button"
          className="toolbar-btn"
          disabled={busy}
          onClick={() =>
            void (mode === "save" ? browseDiskSave() : browseDiskOpen())
          }
        >
          Browse disk…
        </button>
        <button type="button" className="toolbar-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
