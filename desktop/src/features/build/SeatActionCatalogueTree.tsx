import { useMemo, useState } from "react";
import {
  getSeatActionCatalogue,
  loadBundledSeatActions,
  makeUserSavedRange,
} from "../../domain/profiles";
import {
  buildSeatActionTree,
  type SeatActionTreeNode,
} from "../../domain/profiles/seatActionTree";
import type { SeatActionRange } from "../../domain/profiles/seatActionTypes";

interface SaveSource {
  /** Current Build seat range text to persist. */
  rangeText: string;
  /** Short seat label shown in the save form ("OOP" / "IP"). */
  label: string;
}

interface Props {
  onPick: (atom: SeatActionRange) => void;
  /** When set, show Save current + edit/delete for user-saved ranges. */
  saveSource?: SaveSource;
}

function TreeNodes({
  nodes,
  onPick,
}: {
  nodes: SeatActionTreeNode[];
  onPick: (atom: SeatActionRange) => void;
}) {
  return (
    <ul className="seat-tree__list">
      {nodes.map((node) =>
        node.kind === "leaf" ? (
          <li key={node.id}>
            <button
              type="button"
              className="seat-tree__leaf"
              onClick={() => onPick(node.atom)}
            >
              {node.label}
            </button>
          </li>
        ) : (
          <li key={node.id}>
            <details className="seat-tree__branch">
              <summary>{node.label}</summary>
              <TreeNodes nodes={node.children} onPick={onPick} />
            </details>
          </li>
        ),
      )}
    </ul>
  );
}

function catalogue() {
  return getSeatActionCatalogue(loadBundledSeatActions);
}

/** Position → preflop-action range picker. Optionally manages user-saved ranges. */
export function SeatActionCatalogueTree({ onPick, saveSource }: Props) {
  const [version, setVersion] = useState(0);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRange, setEditRange] = useState("");

  const refresh = () => setVersion((value) => value + 1);

  const userSaved = useMemo(() => {
    void version;
    return catalogue().listUserImports();
  }, [version]);

  const tree = useMemo(() => {
    void version;
    const cat = catalogue();
    const bundledOnly = cat.list().filter((atom) => !cat.isUserImport(atom.id));
    return buildSeatActionTree(bundledOnly);
  }, [version]);

  const saveCurrent = () => {
    if (!saveSource) {
      return;
    }
    const name = saveName.trim();
    if (!name) {
      setSaveError("Enter a name for the saved range.");
      return;
    }
    if (!saveSource.rangeText.trim()) {
      setSaveError(`The ${saveSource.label} range is empty.`);
      return;
    }
    catalogue().importAtom(makeUserSavedRange(name, saveSource.rangeText));
    setSaveName("");
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
    catalogue().importAtom(
      makeUserSavedRange(name, editRange, {
        id: editingId,
        dataRevision: Date.now().toString(36),
      }),
    );
    setEditingId(null);
    setSaveError(null);
    refresh();
  };

  const removeSaved = (id: string) => {
    catalogue().removeUserImport(id);
    if (editingId === id) {
      setEditingId(null);
    }
    refresh();
  };

  return (
    <div className="seat-tree" role="tree" aria-label="Range catalogue">
      {saveSource ? (
        <section className="seat-tree__saved" aria-label="Saved ranges">
          <h3 className="seat-tree__section-title">Saved ranges</h3>
          {userSaved.length === 0 ? (
            <p className="empty-hint">No user-saved ranges yet.</p>
          ) : (
            <ul className="seat-tree__saved-list">
              {userSaved.map((atom) => (
                <li key={atom.id} className="seat-tree__saved-item">
                  {editingId === atom.id ? (
                    <div className="seat-tree__edit">
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
                        <button
                          type="button"
                          className="toolbar-btn primary"
                          onClick={commitEdit}
                        >
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
                  ) : (
                    <>
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
                          onClick={() => removeSaved(atom.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="seat-tree__save-form">
            <label>
              Save current {saveSource.label} range as
              <input
                value={saveName}
                placeholder="e.g. BTN open 2.5x"
                onChange={(event) => {
                  setSaveName(event.target.value);
                  setSaveError(null);
                }}
                aria-label={`Name for saved ${saveSource.label} range`}
              />
            </label>
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={saveCurrent}
            >
              Save to catalogue
            </button>
          </div>
          {saveError ? (
            <p className="seat-tree__error" role="alert">
              {saveError}
            </p>
          ) : null}
        </section>
      ) : null}

      <h3 className="seat-tree__section-title">Seat × action</h3>
      {!tree.length ? (
        <p className="empty-hint">No seat×action ranges are loaded.</p>
      ) : (
        <TreeNodes nodes={tree} onPick={onPick} />
      )}
    </div>
  );
}
