import {
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
} from "../../engine/ipcCapabilities";
import type { WorkspaceId } from "../../state/studyStore";

export type { WorkspaceId };

const WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
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

function workspaceUnavailableReason(id: WorkspaceId): string | null {
  if (id === "compare" && !studyIpcFeatureAvailable("compare")) {
    return studyIpcUnavailableReason("compare");
  }
  return null;
}

export function WorkspaceSwitcher({ workspace, onChange }: Props) {
  return (
    <div className="workspace-switcher" aria-label="Workspace">
      <div className="workspace-switcher__tabs" role="tablist" aria-label="Workspace">
        {WORKSPACES.map((entry) => {
          const selected = workspace === entry.id;
          const unavailable = workspaceUnavailableReason(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="workspace-switcher__tab"
              aria-selected={selected}
              aria-disabled={unavailable ? true : undefined}
              disabled={Boolean(unavailable)}
              title={unavailable ?? undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (unavailable) {
                  return;
                }
                onChange(entry.id);
              }}
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
          onChange={(event) => {
            const next = event.target.value as WorkspaceId;
            if (workspaceUnavailableReason(next)) {
              return;
            }
            onChange(next);
          }}
        >
          {WORKSPACES.map((entry) => {
            const unavailable = workspaceUnavailableReason(entry.id);
            return (
              <option
                key={entry.id}
                value={entry.id}
                disabled={Boolean(unavailable)}
                title={unavailable ?? undefined}
              >
                {unavailable ? `${entry.label} (unavailable)` : entry.label}
              </option>
            );
          })}
        </select>
      </label>
    </div>
  );
}
