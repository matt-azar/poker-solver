#!/usr/bin/env node
/**
 * Live OpenAI eval for the study setup assistant.
 *
 * Uses the real OpenAI adapter only when a credential is present:
 *   OPENAI_API_KEY or HOLDEM_STUDY_OPENAI_KEY
 *
 * Not part of ordinary CI (`npm test`). Run manually:
 *   cd desktop && npm run test:assistant-live
 *
 * Exit codes:
 *   0 — skipped (no key) or all cases passed
 *   1 — one or more cases failed / adapter error
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");

// Compile-free path: load TypeScript sources via vitest/vite-node when available,
// otherwise dynamic-import the built helpers after a lightweight inline bootstrap.
async function loadModules() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: join(desktopRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const cases = await server.ssrLoadModule(
      "/src/domain/assistant/liveEvalCases.ts",
    );
    const openai = await server.ssrLoadModule(
      "/src/domain/assistant/openaiProvider.ts",
    );
    const provider = await server.ssrLoadModule(
      "/src/domain/assistant/provider.ts",
    );
    const parse = await server.ssrLoadModule("/src/domain/profiles/parse.ts");
    return { cases, openai, provider, parse, close: () => server.close() };
  } catch (err) {
    await server.close();
    throw err;
  }
}

function readCredential() {
  const fromEnv =
    process.env.HOLDEM_STUDY_OPENAI_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  return fromEnv || null;
}

function loadFixture(name) {
  const path = join(
    desktopRoot,
    "..",
    "configs",
    "range-profiles",
    name,
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const credential = readCredential();
  if (!credential) {
    console.log(
      JSON.stringify(
        {
          status: "skipped",
          reason:
            "No OPENAI_API_KEY or HOLDEM_STUDY_OPENAI_KEY — live OpenAI eval not run",
          hint: "cd desktop && HOLDEM_STUDY_OPENAI_KEY=sk-... npm run test:assistant-live",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const { cases, openai, provider, parse, close } = await loadModules();
  try {
    const fixtures = [
      "fixture-co-bb-srp-100bb-2.5x.json",
      "fixture-co-bb-srp-100bb-2.5x-100nl.json",
      "fixture-co-bb-srp-100bb-3x.json",
      "fixture-btn-bb-3bp-100bb-100nl.json",
    ].map((name) => parse.parseRangeProfileDocument(JSON.stringify(loadFixture(name))));

    const availableProfiles = fixtures.map((p) => provider.profileToMeta(p));
    const assistant = openai.createOpenAiAssistantProvider({
      getCredential: async () => credential,
    });

    const scores = [];
    for (const evalCase of cases.LIVE_EVAL_CASES) {
      process.stderr.write(`live-eval: ${evalCase.id} … `);
      try {
        const proposal = await assistant.interpret({
          text: evalCase.text,
          setupSummary: "empty draft (live eval harness)",
          availableProfiles,
          capabilities: [...provider.DEFAULT_ASSISTANT_CAPABILITIES],
          draftRevision: 1,
        });
        const score = cases.scoreLiveEvalCase(evalCase, proposal);
        scores.push(score);
        process.stderr.write(score.ok ? "ok\n" : "FAIL\n");
        if (!score.ok) {
          for (const field of score.fields.filter((f) => !f.ok)) {
            process.stderr.write(
              `  ${field.field}: expected ${field.expected}, got ${field.actual}\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write("ERROR\n");
        scores.push({
          id: evalCase.id,
          ok: false,
          fields: [
            {
              field: "adapter",
              ok: false,
              expected: "interpret success",
              actual: err instanceof Error ? err.message : String(err),
            },
          ],
        });
      }
    }

    const summary = cases.summarizeLiveEval(scores);
    const report = {
      status: summary.failed === 0 ? "passed" : "failed",
      model: openai.OPENAI_ASSISTANT_DEFAULT_MODEL,
      casePassRate: summary.total
        ? Number((summary.passed / summary.total).toFixed(4))
        : 0,
      fieldAccuracy: Number(summary.fieldAccuracy.toFixed(4)),
      passed: summary.passed,
      failed: summary.failed,
      total: summary.total,
      fieldHits: summary.fieldHits,
      fieldTotal: summary.fieldTotal,
      cases: summary.cases,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(summary.failed === 0 ? 0 : 1);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
