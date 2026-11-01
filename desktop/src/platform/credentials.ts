/**
 * Study-setup assistant credential lookup.
 *
 * Preference order for the desktop prototype:
 * 1. Tauri native secret commands (app-config file outside the webview bundle)
 * 2. Browser prototype localStorage (user-provided; never shipped in source)
 *
 * A distributed product should use an authenticated backend proxy so the
 * client never holds a long-lived vendor API key. This module never embeds keys.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

/** Browser-only fallback key. Not read from env at bundle time. */
export const BROWSER_OPENAI_STORAGE_KEY = "holdem-study-openai-key";

/** Logical service name for Tauri secret storage. */
export const ASSISTANT_OPENAI_SECRET_SERVICE = "openai_assistant";

export type CredentialSource = "tauri" | "localStorage" | "none";

export interface CredentialLookup {
  value: string | null;
  source: CredentialSource;
}

function trimKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function tauriGet(service: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>("assistant_secret_get", {
      service,
    });
    return trimKey(value);
  } catch {
    return null;
  }
}

async function tauriSet(service: string, value: string): Promise<void> {
  await invoke("assistant_secret_set", { service, value });
}

async function tauriClear(service: string): Promise<void> {
  await invoke("assistant_secret_clear", { service });
}

async function tauriHas(service: string): Promise<boolean> {
  try {
    return Boolean(await invoke<boolean>("assistant_secret_has", { service }));
  } catch {
    return false;
  }
}

function browserGet(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return trimKey(localStorage.getItem(BROWSER_OPENAI_STORAGE_KEY));
  } catch {
    return null;
  }
}

function browserSet(value: string): void {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage is unavailable in this runtime");
  }
  localStorage.setItem(BROWSER_OPENAI_STORAGE_KEY, value);
}

function browserClear(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(BROWSER_OPENAI_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Resolve the OpenAI credential without logging or returning it to callers that print. */
export async function getAssistantOpenAiCredential(): Promise<CredentialLookup> {
  if (isTauriRuntime()) {
    const value = await tauriGet(ASSISTANT_OPENAI_SECRET_SERVICE);
    if (value) {
      return { value, source: "tauri" };
    }
    // Dev convenience: allow the browser key when the native store is empty.
    const browser = browserGet();
    if (browser) {
      return { value: browser, source: "localStorage" };
    }
    return { value: null, source: "none" };
  }
  const browser = browserGet();
  return {
    value: browser,
    source: browser ? "localStorage" : "none",
  };
}

/** Persist a user-provided key. Never call this with a hardcoded constant. */
export async function setAssistantOpenAiCredential(value: string): Promise<CredentialSource> {
  const trimmed = trimKey(value);
  if (!trimmed) {
    throw new Error("Credential must be a non-empty string");
  }
  if (isTauriRuntime()) {
    await tauriSet(ASSISTANT_OPENAI_SECRET_SERVICE, trimmed);
    return "tauri";
  }
  browserSet(trimmed);
  return "localStorage";
}

export async function clearAssistantOpenAiCredential(): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await tauriClear(ASSISTANT_OPENAI_SECRET_SERVICE);
    } catch {
      // still clear browser fallback
    }
  }
  browserClear();
}

/** Whether any credential is present (does not return the secret). */
export async function hasAssistantOpenAiCredential(): Promise<boolean> {
  if (isTauriRuntime()) {
    if (await tauriHas(ASSISTANT_OPENAI_SECRET_SERVICE)) {
      return true;
    }
  }
  return browserGet() != null;
}

export function describeCredentialSource(source: CredentialSource): string {
  switch (source) {
    case "tauri":
      return "Tauri native secret store (app config; outside the JS bundle)";
    case "localStorage":
      return "Browser localStorage prototype key (user-provided; not for distribution)";
    case "none":
      return "No credential configured";
  }
}
