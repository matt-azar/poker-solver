import { useMemo, useState } from "react";
import {
  addCatalogueLine,
  addCataloguePosition,
  getSeatActionCatalogue,
  hideBundledAtom,
  isFiledPlacement,
  loadBundledSeatActions,
  makeUserSavedRange,
  normalizePositionName,
  openPlacement,
  parseLineFolderLabel,
  readCatalogueLayout,
  renameCatalogueBranch,
  seatSlotKey,
  writeCatalogueLayout,
  type CatalogueLayout,
  type SeatActionKind,
  type SeatActionRange,
  type SeatPlacement,
} from "../../domain/profiles";
import {
  buildSeatActionTree,
  mergeAtomsForCatalogueTree,
  type SeatActionTreeNode,
} from "../../domain/profiles/seatActionTree";

interface SaveSource {
  /** Current Build seat range text to persist. */
  rangeText: string;
  /** Short seat label shown in the save form ("OOP" / "IP"). */
  label: string;
}

interface Props {
  onPick: (atom: SeatActionRange) => void;
  /** When set, enable filesystem-like catalogue edits. */
  saveSource?: SaveSource;
}

const ACTION_CHOICES: Array<{ id: SeatActionKind; label: string }> = [
  { id: "open", label: "Open" },
  { id: "call", label: "Call" },
  { id: "three_bet", label: "3-bet" },
  { id: "four_bet", label: "4-bet" },
  { id: "four_bet_call", label: "4-bet call" },
  { id: "five_bet", label: "5-bet" },
  { id: "jam", label: "Jam" },
  { id: "fold", label: "Fold" },
];

function catalogue() {
  return getSeatActionCatalogue(loadBundledSeatActions);
}

function layoutStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function loadLayout(): CatalogueLayout {
  return readCatalogueLayout(layoutStorage());
}

function persistLayout(layout: CatalogueLayout) {
  writeCatalogueLayout(layoutStorage(), layout);
}

function promptLabel(message: string, initial: string): string | null {
  const next = window.prompt(message, initial);
  if (next == null) {
    return null;
  }
  const trimmed = next.trim();
  return trimmed || null;
}

function TreeNodes({
  nodes,
  onPick,
  editable,
  onRename,
  onAddLine,
  onSaveInto,
  onReplaceLeaf,
  onEditLeaf,
  onDeleteLeaf,
  isUserImport,
}: {
  nodes: SeatActionTreeNode[];
  onPick: (atom: SeatActionRange) => void;
  editable: boolean;
  onRename: (branchId: string, currentLabel: string) => void;
  onAddLine: (position: string) => void;
  onSaveInto: (placement: SeatPlacement, folderLabel: string) => void;
  onReplaceLeaf: (atom: SeatActionRange) => void;
  onEditLeaf: (atom: SeatActionRange) => void;
  onDeleteLeaf: (atom: SeatActionRange) => void;
  isUserImport: (id: string) => boolean;
}) {
  return (
    <ul className="seat-tree__list">
      {nodes.map((node) =>
        node.kind === "leaf" ? (
          <li key={node.id} className="seat-tree__item">
            <button
              type="button"
              className="seat-tree__leaf"
              onClick={() => onPick(node.atom)}
            >
              {node.label}
              {node.overridden ? (
                <span className="seat-tree__badge">custom</span>
              ) : null}
            </button>
            {editable ? (
              <div className="seat-tree__row-actions">
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => onReplaceLeaf(node.atom)}
                  title="Replace this chart with the current Build range"
                >
                  Replace
                </button>
                {isUserImport(node.atom.id) ? (
                  <>
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => onEditLeaf(node.atom)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => onDeleteLeaf(node.atom)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ) : (
          <li key={node.id}>
            <details className="seat-tree__branch" open={node.children.length === 0}>
              <summary>
                <span className="seat-tree__branch-label">{node.label}</span>
                {editable ? (
                  <span className="seat-tree__row-actions">
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRename(node.id, node.label);
                      }}
                    >
                      Rename
                    </button>
                    {node.position && node.lineLabel === undefined ? (
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onAddLine(node.position!);
                        }}
                      >
                        Add line
                      </button>
                    ) : null}
                    {node.position ? (
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const placement =
                            node.lineLabel == null || node.lineLabel === undefined
                              ? openPlacement(node.position!)
                              : parseLineFolderLabel(
                                  node.position!,
                                  node.lineLabel || "Open",
                                  "call",
                                );
                          if (!placement) {
                            return;
                          }
                          onSaveInto(placement, node.label);
                        }}
                      >
                        Save here
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </summary>
              {node.children.length ? (
                <TreeNodes
                  nodes={node.children}
                  onPick={onPick}
                  editable={editable}
                  onRename={onRename}
                  onAddLine={onAddLine}
                  onSaveInto={onSaveInto}
                  onReplaceLeaf={onReplaceLeaf}
                  onEditLeaf={onEditLeaf}
                  onDeleteLeaf={onDeleteLeaf}
                  isUserImport={isUserImport}
                />
              ) : editable ? (
                <p className="empty-hint seat-tree__empty-folder">Empty folder</p>
              ) : null}
            </details>
          </li>
        ),
      )}
    </ul>
  );
}

/** Position → preflop-action range picker. Optionally manages catalogue folders. */
export function SeatActionCatalogueTree({ onPick, saveSource }: Props) {
  const [version, setVersion] = useState(0);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newPosition, setNewPosition] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRange, setEditRange] = useState("");
  const [saveTarget, setSaveTarget] = useState<{
    placement: SeatPlacement;
    folderLabel: string;
  } | null>(null);
  const [saveAction, setSaveAction] = useState<SeatActionKind>("call");

  const refresh = () => setVersion((value) => value + 1);

  const layout = useMemo(() => {
    void version;
    return loadLayout();
  }, [version]);

  const unfiledSaved = useMemo(() => {
    void version;
    return catalogue()
      .listUserImports()
      .filter((atom) => !isFiledPlacement(atom));
  }, [version]);

  const tree = useMemo(() => {
    void version;
    const cat = catalogue();
    const merged = mergeAtomsForCatalogueTree(cat.list(), {
      isUserImport: (id) => cat.isUserImport(id),
      hiddenBundledIds: layout.hiddenBundledIds,
    });
    return buildSeatActionTree(merged.atoms, layout, {
      overriddenUserIds: merged.overriddenUserIds,
    });
  }, [version, layout]);

  const requireRangeText = (): string | null => {
    if (!saveSource) {
      return null;
    }
    if (!saveSource.rangeText.trim()) {
      setSaveError(`The ${saveSource.label} range is empty.`);
      return null;
    }
    return saveSource.rangeText;
  };

  const saveUnfiled = () => {
    if (!saveSource) {
      return;
    }
    const name = saveName.trim();
    if (!name) {
      setSaveError("Enter a name for the saved range.");
      return;
    }
    const rangeText = requireRangeText();
    if (!rangeText) {
      return;
    }
    catalogue().importAtom(makeUserSavedRange(name, rangeText));
    setSaveName("");
    setSaveError(null);
    refresh();
  };

  const commitSaveInto = () => {
    if (!saveTarget || !saveSource) {
      return;
    }
    const name = saveName.trim();
    if (!name) {
      setSaveError("Enter a name for the saved range.");
      return;
    }
    const rangeText = requireRangeText();
    if (!rangeText) {
      return;
    }
    let placement = saveTarget.placement;
    if (placement.vsAction !== "none") {
      placement = { ...placement, action: saveAction };
    }
    // Hide any bundled chart that occupies this slot so Replace/Save here sticks.
    const slot = seatSlotKey(placement);
    const live = catalogue();
    for (const atom of live.list()) {
      if (!live.isUserImport(atom.id) && seatSlotKey(atom) === slot) {
        persistLayout(hideBundledAtom(loadLayout(), atom.id));
      }
    }
    live.importAtom(makeUserSavedRange(name, rangeText, { placement }));
    setSaveName("");
    setSaveTarget(null);
    setSaveError(null);
    refresh();
  };

  const beginEdit = (atom: SeatActionRange) => {
    setEditingId(atom.id);
    setEditName(atom.displayName);
    setEditRange(atom.range);
    setSaveError(null);
  };

  const commitEdit = () => {
    if (!editingId) {
      return;
    }
    const name = editName.trim();
    if (!name) {
      setSaveError("Saved range name cannot be empty.");
      return;
    }
    const existing = catalogue().get(editingId);
    const placement =
      existing && isFiledPlacement(existing)
        ? {
            heroPosition: existing.heroPosition,
            villainPosition: existing.villainPosition,
            action: existing.action,
            vsAction: existing.vsAction,
          }
        : undefined;
    catalogue().importAtom(
      makeUserSavedRange(name, editRange, {
        id: editingId,
        dataRevision: Date.now().toString(36),
        placement,
      }),
    );
    setEditingId(null);
    setSaveError(null);
    refresh();
  };

  const removeSaved = (atom: SeatActionRange) => {
    catalogue().removeUserImport(atom.id);
    if (editingId === atom.id) {
      setEditingId(null);
    }
    refresh();
  };

  const renameBranch = (branchId: string, currentLabel: string) => {
    const next = promptLabel(`Rename folder "${currentLabel}"`, currentLabel);
    if (next == null) {
      return;
    }
    persistLayout(renameCatalogueBranch(loadLayout(), branchId, next));
    refresh();
  };

  const addPosition = () => {
    const normalized = normalizePositionName(newPosition);
    if (!normalized) {
      setSaveError("Enter a position name (e.g. HJ, EP, BTN).");
      return;
    }
    persistLayout(addCataloguePosition(loadLayout(), normalized));
    setNewPosition("");
    setSaveError(null);
    refresh();
  };

  const addLine = (position: string) => {
    const next = promptLabel(
      `Add line folder under ${position} (e.g. vs CO open)`,
      "vs CO open",
    );
    if (next == null) {
      return;
    }
    if (!parseLineFolderLabel(position, next, "call") && !/^open$/i.test(next)) {
      setSaveError('Line folders look like "vs CO open" or "Open".');
      return;
    }
    persistLayout(addCatalogueLine(loadLayout(), position, next));
    setSaveError(null);
    refresh();
  };

  const replaceLeaf = (atom: SeatActionRange) => {
    const rangeText = requireRangeText();
    if (!rangeText) {
      return;
    }
    const name =
      promptLabel(`Name for replacement of "${atom.displayName}"`, atom.displayName) ??
      atom.displayName;
    const placement: SeatPlacement = {
      heroPosition: atom.heroPosition,
      villainPosition: atom.villainPosition,
      action: atom.action,
      vsAction: atom.vsAction,
    };
    const live = catalogue();
    if (!live.isUserImport(atom.id)) {
      persistLayout(hideBundledAtom(loadLayout(), atom.id));
    }
    const id = live.isUserImport(atom.id)
      ? atom.id
      : `user-saved-${seatSlotKey(placement).toLowerCase().replace(/\|/g, "-")}`;
    live.importAtom(
      makeUserSavedRange(name, rangeText, {
        id,
        placement,
        dataRevision: Date.now().toString(36),
      }),
    );
    setSaveError(null);
    refresh();
  };

  const startSaveInto = (placement: SeatPlacement, folderLabel: string) => {
    setSaveTarget({ placement, folderLabel });
    setSaveAction(placement.action === "open" ? "open" : placement.action);
    setSaveName("");
    setSaveError(null);
  };

  return (
    <div className="seat-tree" role="tree" aria-label="Range catalogue">
      {saveSource ? (
        <section className="seat-tree__toolbar" aria-label="Catalogue folders">
          <div className="seat-tree__save-form">
            <label>
              Add position folder
              <input
                value={newPosition}
                placeholder="e.g. EP"
                onChange={(event) => {
                  setNewPosition(event.target.value);
                  setSaveError(null);
                }}
                aria-label="New position folder name"
              />
            </label>
            <button type="button" className="toolbar-btn" onClick={addPosition}>
              Add position
            </button>
          </div>
          {saveTarget ? (
            <div className="seat-tree__save-into" aria-label="Save into folder">
              <p className="seat-tree__save-into-label">
                Save current {saveSource.label} into <strong>{saveTarget.folderLabel}</strong>
              </p>
              <div className="seat-tree__save-form">
                <label>
                  Name
                  <input
                    value={saveName}
                    placeholder="e.g. HJ open 2.5x"
                    onChange={(event) => {
                      setSaveName(event.target.value);
                      setSaveError(null);
                    }}
                    aria-label="Name for range saved into folder"
                  />
                </label>
                {saveTarget.placement.vsAction !== "none" ? (
                  <label>
                    Action
                    <select
                      value={saveAction}
                      onChange={(event) =>
                        setSaveAction(event.target.value as SeatActionKind)
                      }
                      aria-label="Action for saved range"
                    >
                      {ACTION_CHOICES.filter((choice) => choice.id !== "open").map(
                        (choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="toolbar-btn primary"
                  onClick={commitSaveInto}
                >
                  Save into folder
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setSaveTarget(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <h3 className="seat-tree__section-title">Seat × action</h3>
      {!tree.length ? (
        <p className="empty-hint">No seat×action ranges are loaded.</p>
      ) : (
        <TreeNodes
          nodes={tree}
          onPick={onPick}
          editable={Boolean(saveSource)}
          onRename={renameBranch}
          onAddLine={addLine}
          onSaveInto={startSaveInto}
          onReplaceLeaf={replaceLeaf}
          onEditLeaf={beginEdit}
          onDeleteLeaf={removeSaved}
          isUserImport={(id) => catalogue().isUserImport(id)}
        />
      )}

      {saveSource ? (
        <section className="seat-tree__saved" aria-label="Unfiled saved ranges">
          <h3 className="seat-tree__section-title">Unfiled saves</h3>
          <p className="empty-hint">
            Saves without a seat folder. Use Save here / Replace on a folder to file them.
          </p>
          {unfiledSaved.length === 0 ? (
            <p className="empty-hint">No unfiled saves.</p>
          ) : (
            <ul className="seat-tree__saved-list">
              {unfiledSaved.map((atom) => (
                <li key={atom.id} className="seat-tree__saved-item">
                  <button
                    type="button"
                    className="seat-tree__leaf"
                    onClick={() => onPick(atom)}
                  >
                    {atom.displayName}
                  </button>
                  <div className="seat-tree__saved-actions">
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => beginEdit(atom)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => removeSaved(atom)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="seat-tree__save-form">
            <label>
              Save current {saveSource.label} range (unfiled)
              <input
                value={saveTarget ? "" : saveName}
                placeholder="e.g. Scratch pad"
                disabled={Boolean(saveTarget)}
                onChange={(event) => {
                  setSaveName(event.target.value);
                  setSaveError(null);
                }}
                aria-label={`Name for unfiled ${saveSource.label} range`}
              />
            </label>
            <button
              type="button"
              className="toolbar-btn"
              disabled={Boolean(saveTarget)}
              onClick={saveUnfiled}
            >
              Save unfiled
            </button>
          </div>
        </section>
      ) : null}

      {editingId && saveSource ? (
        <div className="seat-tree__edit seat-tree__edit--dock">
          <h3 className="seat-tree__section-title">Edit saved range</h3>
          <label>
            Name
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              aria-label="Saved range name"
            />
          </label>
          <label>
            Range text
            <textarea
              rows={3}
              value={editRange}
              onChange={(event) => setEditRange(event.target.value)}
              aria-label="Saved range text"
            />
          </label>
          <div className="seat-tree__saved-actions">
            <button type="button" className="toolbar-btn primary" onClick={commitEdit}>
              Save changes
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setEditingId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {saveError ? (
        <p className="seat-tree__error" role="alert">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
