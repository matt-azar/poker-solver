/**
 * Build can only author a subset of street-config 1. Reject portable jobs that
 * would silently change on Export (e.g. first-to-act 1 → 0).
 */
import { parseStreetConfigTextToSolutionConfig } from "../../engine/streetConfigText";
import type { StudyJob } from "./types";

export class JobNotRepresentableError extends Error {
  readonly code = "job_not_representable";
  constructor(message: string) {
    super(message);
    this.name = "JobNotRepresentableError";
  }
}

/**
 * Fields Build's draft → street-config serializer currently hardcodes or omits.
 * first-to-act is always emitted as 0 from formatSolveJobStreetConfig.
 */
export function assertJobRepresentableInBuild(job: StudyJob): void {
  const config = parseStreetConfigTextToSolutionConfig(job.street_config);
  const first = config.first_to_act;
  if (first != null && Number(first) !== 0) {
    throw new JobNotRepresentableError(
      `Build cannot represent first-to-act ${first} (Study draft always exports first-to-act 0). Edit the job or solve via CLI.`,
    );
  }
}
