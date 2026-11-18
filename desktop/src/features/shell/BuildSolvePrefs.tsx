/**
 * Per-solve draft resources shown beside Build (not in Settings).
 * Settings keeps display prefs only.
 */
import { useMemo } from "react";
import {
  fastSolveDefaults,
  formatHardwareHint,
} from "../../domain/hardwareDefaults";
import { useStudyStore } from "../../state/studyStore";

export function BuildSolvePrefs() {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const machineDefaults = useMemo(() => fastSolveDefaults(), []);
  const hardwareHint = formatHardwareHint(machineDefaults);

  return (
    <section
      className="build-solve-prefs"
      aria-label="Per-solve resources"
      data-testid="build-solve-prefs"
    >
      <div className="build-solve-prefs__head">
        <h2 className="build-solve-prefs__title">Solve resources</h2>
        <span className="muted build-solve-prefs__hint">{hardwareHint}</span>
      </div>
      <div className="build-solve-prefs__grid">
        <label className="settings-field">
          Threads
          <input
            type="number"
            min={1}
            max={64}
            value={draft.threads}
            onChange={(event) =>
              updateDraft({ threads: Number(event.target.value), frozen: true })
            }
          />
        </label>
        <label className="settings-field">
          Memory MiB
          <input
            type="number"
            min={64}
            value={draft.memoryMib}
            onChange={(event) =>
              updateDraft({ memoryMib: Number(event.target.value) })
            }
          />
        </label>
        <label
          className="settings-field"
          title="How many full EV/gap refreshes to aim for during a solve."
        >
          Samples
          <input
            type="number"
            min={0}
            value={draft.samples}
            onChange={(event) =>
              updateDraft({ samples: Number(event.target.value) })
            }
          />
        </label>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() =>
            updateDraft({
              threads: machineDefaults.threads,
              memoryMib: machineDefaults.memoryMib,
              frozen: true,
            })
          }
        >
          Reset to fast
        </button>
      </div>
    </section>
  );
}
