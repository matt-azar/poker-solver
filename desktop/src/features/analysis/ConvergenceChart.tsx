import { useMemo } from "react";
import { useStudyStore } from "../../state/studyStore";

export function ConvergenceChart() {
  const samples = useStudyStore((s) => s.status?.samples);

  const path = useMemo(() => {
    const list = samples ?? [];
    if (!list.length) {
      return "";
    }
    const gaps = list.map((sample) => sample.nash_gap);
    const maxGap = Math.max(...gaps, 1e-9);
    const maxIter = Math.max(...list.map((sample) => sample.iteration), 1);
    return list
      .map((sample, index) => {
        const x = (sample.iteration / maxIter) * 100;
        const y = 100 - (sample.nash_gap / maxGap) * 100;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [samples]);

  const count = samples?.length ?? 0;

  return (
    <div className="convergence-chart">
      <div className="panel-title-row">
        <h2 className="panel-title">NashConv samples</h2>
        <span className="muted">gap vs iteration — not a fabricated ETA</span>
      </div>
      {count ? (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="convergence-svg"
        >
          <path
            d={path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <p className="empty-hint">Progress samples appear while solving.</p>
      )}
    </div>
  );
}
