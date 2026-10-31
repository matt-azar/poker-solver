import type { WorkspaceId } from "../../state/studyStore";

export type { WorkspaceId };

const WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
  { id: "study", label: "Study" },
  { id: "build", label: "Build" },
  { id: "compare", label: "Compare" },
  { id: "library", label: "Library" },
];

interface Props {
  workspace: WorkspaceId;
  onChange: (id: WorkspaceId) => void;
}

export function WorkspaceSwitcher({ workspace, onChange }: Props) {
  return (
    <div className="workspace-switcher" role="tablist" aria-label="Workspace">
      {WORKSPACES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-pressed={workspace === entry.id}
          onClick={() => onChange(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
