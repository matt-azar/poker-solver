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

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_PREVIEW_COMMIT_SHA": JSON.stringify(previewCommitSha()),
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
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
