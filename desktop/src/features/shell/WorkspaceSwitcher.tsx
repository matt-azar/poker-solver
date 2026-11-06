import type { WorkspaceId } from "../../state/studyStore";

export type { WorkspaceId };

export const WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
  { id: "study", label: "Study" },
  { id: "build", label: "Build" },
  { id: "equity", label: "Equity" },
  { id: "compare", label: "Compare" },
  { id: "library", label: "Library" },
];

interface Props {
  workspace: WorkspaceId;
  onChange: (id: WorkspaceId) => void;
}

export function WorkspaceSwitcher({ workspace, onChange }: Props) {
  return (
    <div className="workspace-switcher" aria-label="Workspace">
      <div className="workspace-switcher__tabs" role="tablist" aria-label="Workspace">
        {WORKSPACES.map((entry) => {
          const selected = workspace === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="workspace-switcher__tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(entry.id)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <label className="workspace-switcher__compact">
        <span className="workspace-switcher__compact-label">Workspace</span>
        <select
          value={workspace}
          aria-label="Workspace"
          onChange={(event) => onChange(event.target.value as WorkspaceId)}
        >
          {WORKSPACES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
