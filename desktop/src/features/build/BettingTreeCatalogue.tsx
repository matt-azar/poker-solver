/**
 * One-level betting-tree catalogue (localStorage) — save / open / rename / delete.
 * No OS file dialogs; mirrors the flat unfiled range-catalogue pattern.
 */
import { useMemo, useState } from "react";
import {
  getBettingTreeCatalogue,
  type SavedBettingTree,
} from "../../domain/bettingTreeCatalogue";
import { bettingTreeFromDraft } from "../../domain/bettingTreeFile";
import type { SpotDraft } from "../../domain/types";

export interface BettingTreeCatalogueProps {
  draft: SpotDraft;
  onOpen: (entry: SavedBettingTree) => void;
  onClose: () => void;
  /** Prefer focusing the save form when opened from Save tree. */
  initialMode?: "save" | "open";
}

export function BettingTreeCatalogue({
  draft,
  onOpen,
  onClose,
  initialMode = "open",
}: BettingTreeCatalogueProps) {
  const catalogue = getBettingTreeCatalogue();
  const [revision, setRevision] = useState(0);
  const [saveName, setSaveName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [highlightSave, setHighlightSave] = useState(initialMode === "save");

  const entries = useMemo(() => {
    void revision;
    return catalogue.list();
  }, [catalogue, revision]);

  const refresh = () => setRevision((value) => value + 1);

  const commitSave = () => {
    const name = saveName.trim();
    if (!name) {
      setError("Enter a name for the saved tree.");
      return;
    }
    try {
      catalogue.save(name, bettingTreeFromDraft(draft, { name }));
      setSaveName("");
      setError(null);
      setHighlightSave(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const beginRename = (entry: SavedBettingTree) => {
    setEditingId(entry.id);
    setEditName(entry.displayName);
    setError(null);
  };

  const commitRename = () => {
    if (!editingId) {
      return;
    }
    const name = editName.trim();
    if (!name) {
      setError("Saved tree name cannot be empty.");
      return;
    }
    const renamed = catalogue.rename(editingId, name);
    if (!renamed) {
      setError("Could not rename that tree.");
      return;
    }
    setEditingId(null);
    setEditName("");
    setError(null);
    refresh();
  };

  const removeEntry = (entry: SavedBettingTree) => {
    catalogue.remove(entry.id);
    if (editingId === entry.id) {
      setEditingId(null);
      setEditName("");
    }
    setError(null);
    refresh();
  };

  return (
    <div className="tree-catalogue" aria-label="Betting tree catalogue">
      <p className="tree-catalogue__help">
        Named trees store sizes, caps, and line edits only. Board, ranges, and stop
        stay as they are.
      </p>

      <section className="tree-catalogue__list" aria-label="Saved betting trees">
        <h3 className="tree-catalogue__title">Saved trees</h3>
        {entries.length === 0 ? (
          <p className="empty-hint">No saved trees yet.</p>
        ) : (
          <ul className="tree-catalogue__items">
            {entries.map((entry) => (
              <li key={entry.id} className="tree-catalogue__item">
                {editingId === entry.id ? (
                  <div className="tree-catalogue__edit">
                    <label>
                      Name
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        aria-label="Saved tree name"
                      />
                    </label>
                    <div className="tree-catalogue__row-actions">
                      <button
                        type="button"
                        className="toolbar-btn primary"
                        onClick={commitRename}
                      >
                        Save changes
                      </button>
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={() => {
                          setEditingId(null);
                          setEditName("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="tree-catalogue__row">
                    <button
                      type="button"
                      className="tree-catalogue__open"
                      onClick={() => onOpen(entry)}
                    >
                      {entry.displayName}
                    </button>
                    <div className="tree-catalogue__row-actions">
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={() => beginRename(entry)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={() => removeEntry(entry)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className={
          highlightSave
            ? "tree-catalogue__save tree-catalogue__save--focus"
            : "tree-catalogue__save"
        }
        aria-label="Save current betting tree"
      >
        <h3 className="tree-catalogue__title">Save current tree</h3>
        <div className="tree-catalogue__save-form">
          <label>
            Name
            <input
              value={saveName}
              placeholder="e.g. SRP medium"
              onChange={(event) => {
                setSaveName(event.target.value);
                setError(null);
              }}
              aria-label="Name for saved betting tree"
              autoFocus={initialMode === "save"}
            />
          </label>
          <button type="button" className="toolbar-btn primary" onClick={commitSave}>
            Save
          </button>
        </div>
      </section>

      {error ? (
        <p className="tree-catalogue__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="tree-catalogue__footer">
        <button type="button" className="toolbar-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
