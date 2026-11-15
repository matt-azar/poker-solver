/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function previewCommitSha(): string {
  const fromEnv =
    process.env.VITE_PREVIEW_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.COMMIT_SHA;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ mode }) => {
  const publicDemo = mode === "public-demo";
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_PREVIEW_COMMIT_SHA": JSON.stringify(previewCommitSha()),
      // Public static build always boots precomputed demo; private QA uses
      // `preview:scenario` / `?preview=` on the default Vite entry instead.
      "import.meta.env.VITE_PUBLIC_DEMO": JSON.stringify(
        publicDemo || process.env.VITE_PUBLIC_DEMO === "true" ? "true" : "",
      ),
    },
    server: {
      port: 5173,
      fs: {
        // Allow importing model context packs from docs/ai-context/*.md
        allow: [".."],
      },
      // No HTTP explorer proxy — packaged and Tauri-dev Study use solver-engine IPC.
    },
    build: {
      outDir: publicDemo ? "dist-public-demo" : "dist",
      emptyOutDir: true,
      sourcemap: !publicDemo,
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  };
});
