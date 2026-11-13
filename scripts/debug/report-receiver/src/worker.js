/**
 * Holdem Study debug report receiver (Cloudflare Worker).
 *
 * Accepts multipart POSTs from scripts/debug/send_report.py when
 * HOLDEM_STUDY_REPORT_WEBHOOK_URL points here. Shared secret on the
 * request; GitHub PAT lives only in Worker secrets (never on Matt's PC).
 *
 * Zip attach uses a rolling prerelease (`study-debug-reports`) so binary
 * uploads stay intact (Gist REST JSON is text-oriented).
 *
 * Copyright (c) Matt Azar. UNLICENSED — no license is granted.
 */

const ATTACHMENT_PLACEHOLDER = "(pending upload)";
const RELEASE_TAG = "study-debug-reports";
const MAX_ZIP_BYTES = 40 * 1024 * 1024; // 40 MiB

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "holdem-study-report-receiver" });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/report")) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const auth = checkSecret(request, env);
    if (!auth.ok) {
      return json({ ok: false, error: auth.error }, 401);
    }

    const token = (env.GITHUB_TOKEN || "").trim();
    if (!token) {
      return json({ ok: false, error: "server_misconfigured_github_token" }, 500);
    }

    let form;
    try {
      form = await request.formData();
    } catch (err) {
      return json({ ok: false, error: "invalid_multipart", detail: String(err) }, 400);
    }

    const zipEntry = form.get("zip");
    if (!zipEntry || typeof zipEntry === "string" || !zipEntry.arrayBuffer) {
      return json({ ok: false, error: "missing_zip" }, 400);
    }
    const zipBytes = new Uint8Array(await zipEntry.arrayBuffer());
    if (zipBytes.byteLength === 0) {
      return json({ ok: false, error: "empty_zip" }, 400);
    }
    if (zipBytes.byteLength > MAX_ZIP_BYTES) {
      return json(
        {
          ok: false,
          error: "zip_too_large",
          max_bytes: MAX_ZIP_BYTES,
          got_bytes: zipBytes.byteLength,
        },
        413
      );
    }

    const title = String(form.get("title") || "").trim() || "Study debug report";
    let body = String(form.get("body") || "");
    if (!body.trim()) {
      return json({ ok: false, error: "missing_body" }, 400);
    }
    const repo =
      String(form.get("repo") || "").trim() ||
      String(env.GITHUB_REPO || "matt-azar/poker-solver").trim();
    const attach = String(form.get("attach") || "release").trim().toLowerCase();
    const labels = parseLabels(form.get("labels"));
    const zipName =
      String(form.get("zip_name") || "").trim() ||
      (typeof zipEntry.name === "string" && zipEntry.name) ||
      "diagnostics.zip";
    const dryRun = String(form.get("dry_run") || "").toLowerCase() === "true";

    if (dryRun || String(env.DRY_RUN || "").toLowerCase() === "true") {
      return json({
        ok: true,
        dry_run: true,
        repo,
        title,
        zip_name: zipName,
        zip_bytes: zipBytes.byteLength,
        labels,
        attach,
        issue_url: null,
        issue_number: null,
        attachment_url: null,
      });
    }

    const api = (env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
    let attachmentUrl = "";
    let attachmentLine = "_Not uploaded (`attach=none`)._";

    try {
      if (attach === "none") {
        /* issue text only */
      } else if (attach === "release" || attach === "gist" || attach === "" || attach === "default") {
        // Always use release assets for binary-safe zip storage on the server path.
        // (Client-side local `gh gist create` can still use secret gists.)
        const assetName = sanitizeAssetName(zipName);
        attachmentUrl = await uploadReleaseAsset(api, token, repo, assetName, zipBytes);
        attachmentLine = `[release asset](${attachmentUrl})`;
      } else {
        return json({ ok: false, error: "unsupported_attach", attach }, 400);
      }

      body = body.includes(ATTACHMENT_PLACEHOLDER)
        ? body.split(ATTACHMENT_PLACEHOLDER).join(attachmentLine)
        : `${body}\n\n### Attachment\n\n${attachmentLine}\n`;

      const issue = await createIssue(api, token, repo, { title, body, labels });
      return json({
        ok: true,
        dry_run: false,
        repo,
        title,
        issue_url: issue.html_url,
        issue_number: issue.number,
        attachment_url: attachmentUrl || null,
        attach: attachmentUrl ? "release" : "none",
        zip_name: zipName,
        zip_bytes: zipBytes.byteLength,
      });
    } catch (err) {
      return json(
        {
          ok: false,
          error: "github_api_failed",
          detail: String(err && err.message ? err.message : err),
        },
        502
      );
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Holdem-Study-Report-Secret",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function checkSecret(request, env) {
  const expected = (env.REPORT_SHARED_SECRET || "").trim();
  if (!expected) {
    return { ok: false, error: "server_misconfigured_shared_secret" };
  }
  const headerSecret =
    request.headers.get("X-Holdem-Study-Report-Secret") ||
    request.headers.get("x-holdem-study-report-secret") ||
    "";
  const auth = request.headers.get("Authorization") || "";
  let bearer = "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) bearer = m[1].trim();
  const got = (headerSecret || bearer).trim();
  if (!got || !timingSafeEqual(got, expected)) {
    return { ok: false, error: "unauthorized" };
  }
  return { ok: true };
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function parseLabels(raw) {
  if (raw == null || raw === "") return ["bug"];
  if (typeof raw !== "string") return ["bug"];
  const s = raw.trim();
  if (!s) return ["bug"];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map(String).filter(Boolean);
    }
  } catch {
    /* comma-separated */
  }
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function sanitizeAssetName(name) {
  const base = String(name || "diagnostics.zip").replace(/[/\\]/g, "_");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  if (base.toLowerCase().endsWith(".zip")) {
    return `study-debug-${stamp}-${base}`;
  }
  return `study-debug-${stamp}-${base}.zip`;
}

async function githubFetch(api, token, path, init) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "holdem-study-report-receiver",
      ...(init && init.headers ? init.headers : {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) ||
      `GitHub HTTP ${res.status}: ${text.slice(0, 300)}`;
    throw new Error(msg);
  }
  return data;
}

async function ensurePrerelease(api, token, repo) {
  const [owner, name] = splitRepo(repo);
  try {
    return await githubFetch(
      api,
      token,
      `/repos/${owner}/${name}/releases/tags/${RELEASE_TAG}`
    );
  } catch (err) {
    if (!/404|Not Found/i.test(String(err.message || err))) throw err;
  }
  return githubFetch(api, token, `/repos/${owner}/${name}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: "Study debug report uploads",
      body:
        "Rolling prerelease for diagnostics zip attachments from the " +
        "study-debug report receiver. Not a product release. " +
        "Assets are crash/hang evidence — treat as private.",
      prerelease: true,
      draft: false,
    }),
  });
}

async function uploadReleaseAsset(api, token, repo, assetName, zipBytes) {
  const release = await ensurePrerelease(api, token, repo);
  const uploadTemplate = release.upload_url;
  if (!uploadTemplate) throw new Error("release missing upload_url");
  const uploadUrl = uploadTemplate.replace(/\{[^}]*\}/g, "") + `?name=${encodeURIComponent(assetName)}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/zip",
      "Content-Length": String(zipBytes.byteLength),
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "holdem-study-report-receiver",
    },
    body: zipBytes,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      (data && data.message) || `asset upload HTTP ${res.status}: ${text.slice(0, 300)}`
    );
  }
  const [owner, name] = splitRepo(repo);
  return (
    (data && data.browser_download_url) ||
    `https://github.com/${owner}/${name}/releases/download/${RELEASE_TAG}/${assetName}`
  );
}

async function createIssue(api, token, repo, { title, body, labels }) {
  const [owner, name] = splitRepo(repo);
  const payload = { title, body };
  if (labels && labels.length) payload.labels = labels;
  try {
    return await githubFetch(api, token, `/repos/${owner}/${name}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (labels && labels.length && /label/i.test(String(err.message || err))) {
      return githubFetch(api, token, `/repos/${owner}/${name}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
    }
    throw err;
  }
}

function splitRepo(repo) {
  const parts = String(repo).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repo: ${repo}`);
  }
  return parts;
}
