/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PREVIEW_COMMIT_SHA?: string;
  /** Set in the public-demo Vite mode / static build only. */
  readonly VITE_PUBLIC_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
