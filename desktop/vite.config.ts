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

function normalizeBase(raw: string | undefined): string {
  const value = (raw || "/").trim() || "/";
  if (value === "/") {
    return "/";
  }
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

export default defineConfig(({ mode }) => {
  const publicDemo = mode === "public-demo";
  // GitHub Pages project site needs `/poker-solver/`; local preview keeps `/`.
  // Set PUBLIC_DEMO_BASE (or VITE_BASE) in the deploy workflow only.
  const base = publicDemo
    ? normalizeBase(process.env.PUBLIC_DEMO_BASE || process.env.VITE_BASE)
    : "/";
  return {
    plugins: [react()],
    base,
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
