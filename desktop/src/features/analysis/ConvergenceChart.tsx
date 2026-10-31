import { useMemo } from "react";
import { gapSamplesFromStatus } from "../../domain/status";
import { useStudyStore } from "../../state/studyStore";

export function ConvergenceChart() {
  const status = useStudyStore((s) => s.status);
  const samples = useMemo(() => gapSamplesFromStatus(status), [status]);

  const path = useMemo(() => {
    if (!samples.length) {
      return "";
    }
    const gaps = samples.map((sample) => sample.nash_gap);
    const maxGap = Math.max(...gaps, 1e-9);
    const maxIter = Math.max(...samples.map((sample) => sample.iteration), 1);
    return samples
      .map((sample, index) => {
        const x = (sample.iteration / maxIter) * 100;
        const y = 100 - (sample.nash_gap / maxGap) * 100;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [samples]);

  return (
    <div className="convergence-chart">
      <div className="panel-title-row">
        <h2 className="panel-title">NashConv samples</h2>
        <span className="muted">
          {samples.length
            ? `${samples.length} point(s) from gap_series`
            : "gap vs iteration — not a fabricated ETA"}
        </span>
      </div>
      {samples.length ? (
        <>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="convergence-svg"
            role="img"
            aria-label="NashConv gap versus iteration"
          >
            <path
              d={path}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="convergence-legend tabular muted">
            {samples.map((sample) => (
              <span key={sample.iteration}>
                i{sample.iteration}: {sample.nash_gap.toFixed(3)}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="empty-hint">Progress samples appear in status.gap_series while solving.</p>
      )}
    </div>
  );
}
