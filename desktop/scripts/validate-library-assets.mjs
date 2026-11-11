#!/usr/bin/env node
/**
 * Validate shipped Library catalogue files under configs/templates and
 * configs/ranges. Fails loudly on empty/invalid entries and missing
 * representative IDs used by Study / docs.
 *
 * Usage (from repo root or desktop/):
 *   node desktop/scripts/validate-library-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const templatesRoot = path.join(repoRoot, "configs", "templates");
const rangesRoot = path.join(repoRoot, "configs", "ranges");

const REQUIRED_TEMPLATES = ["flop-check-down", "flop-small-bet", "turn-probe"];
const REQUIRED_RANGES = ["broadway", "open/utg-open", "value-heavy"];

const errors = [];

function walkTxtFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) {
    errors.push(`missing directory: ${root}`);
    return out;
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".txt")) {
        out.push(full);
      }
    }
  }
  return out;
}

function relativeId(root, filePath) {
  const rel = path.relative(root, filePath).replaceAll("\\", "/");
  return rel.replace(/\.txt$/i, "");
}

function validateTemplates() {
  const files = walkTxtFiles(templatesRoot);
  const ids = new Set();
  for (const file of files) {
    const id = relativeId(templatesRoot, file);
    if (id.includes("/") || id.includes("..")) {
      errors.push(`template id must be flat filename stem: ${id}`);
      continue;
    }
    ids.add(id);
    const text = fs.readFileSync(file, "utf8").replace(/\r/g, "");
    if (!text.trim()) {
      errors.push(`empty template: ${id}`);
      continue;
    }
    const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    if (!first.startsWith("street-config ")) {
      errors.push(`template ${id} must start with street-config (got ${JSON.stringify(first)})`);
    }
  }
  for (const id of REQUIRED_TEMPLATES) {
    if (!ids.has(id)) {
      errors.push(`missing required template id: ${id}`);
    }
  }
  return ids;
}

function validateRanges() {
  const files = walkTxtFiles(rangesRoot);
  const ids = new Set();
  for (const file of files) {
    const id = relativeId(rangesRoot, file);
    if (id.split("/").some((seg) => seg === ".." || seg === "")) {
      errors.push(`unsafe range id: ${id}`);
      continue;
    }
    ids.add(id);
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) {
      errors.push(`empty range preset: ${id}`);
    }
  }
  for (const id of REQUIRED_RANGES) {
    if (!ids.has(id)) {
      errors.push(`missing required range id: ${id}`);
    }
  }
  return ids;
}

const templateIds = validateTemplates();
const rangeIds = validateRanges();

if (errors.length) {
  console.error("Library asset validation failed:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  `Library assets ok: ${templateIds.size} templates, ${rangeIds.size} ranges ` +
    `(required templates=[${REQUIRED_TEMPLATES.join(", ")}]; ` +
    `required ranges=[${REQUIRED_RANGES.join(", ")}])`,
);
