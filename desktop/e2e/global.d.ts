import type { PreviewFixtureTestApi } from "../src/preview/previewMode";

export {};

declare global {
  interface Window {
    __STUDY_PREVIEW_FIXTURE__?: PreviewFixtureTestApi;
    __STUDY_PREVIEW_DEBUG__?: {
      nodeId: string | null;
      nodeValuesId: string | null;
      nodeEv: number | null;
      valuesPending: boolean;
    };
    __STUDY_DEMO_DEBUG__?: {
      exampleId: string;
      variantId: string;
      nodeId: string | null;
      nodeEv: number | null;
      actionFrequencies: number[] | null;
      fetchedPaths: string[];
    };
  }
}
