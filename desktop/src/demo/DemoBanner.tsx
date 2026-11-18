/**
 * Public demo chrome: Precomputed label, example/variant switchers,
 * shareable-URL sync, Download for Windows.
 *
 * Cursor-minimal: one slim strip — badge + example + quiet Download.
 * Board/line live in Study green node nav, not here.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStudyStore } from "../state/studyStore";
import {
  getActiveDemoConfig,
  publishDemoDebugSnapshot,
  setDemoExample,
  setDemoVariant,
  subscribeDemoMode,
  writeDemoUrlState,
} from "./demoMode";
import { usePhoneDemoLayout } from "./phoneLayout";
import type { DemoBootConfig } from "./types";

const WINDOWS_INSTALLER_FALLBACK =
  "https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe";

function useDemoConfig(): DemoBootConfig | null {
  return useSyncExternalStore(subscribeDemoMode, getActiveDemoConfig, () => null);
}

export function DemoBanner() {
  const config = useDemoConfig();
  const phoneDemo = usePhoneDemoLayout();
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const navigateTo = useStudyStore((s) => s.navigateTo);
  const startPolling = useStudyStore((s) => s.startPolling);
  const deepLinkApplied = useRef<string | null>(null);

  // Playwright + shareable URL: keep ?node= in sync with the live Study node.
  useEffect(() => {
    if (!config || !currentNode?.node_id) {
      return;
    }
    writeDemoUrlState(
      {
        exampleId: config.exampleId,
        variantId:
          config.variantId === config.manifest.default_variant
            ? null
            : config.variantId,
        nodeId:
          currentNode.node_id === config.manifest.root_node_id
            ? null
            : currentNode.node_id,
      },
      { notify: false },
    );
    publishDemoDebugSnapshot({
      nodeId: currentNode.node_id,
      nodeEv:
        typeof nodeValues?.node_ev === "number" ? nodeValues.node_ev : null,
      actionFrequencies: Array.isArray(currentNode.action_frequencies)
        ? currentNode.action_frequencies
        : null,
    });
  }, [config, currentNode, nodeValues]);

  // Deep link: after root loads, jump to ?node= once per URL target.
  useEffect(() => {
    if (!config?.nodeId || !currentNode?.node_id) {
      return;
    }
    const target = config.nodeId;
    if (currentNode.node_id === target) {
      deepLinkApplied.current = target;
      return;
    }
    if (deepLinkApplied.current === target) {
      return;
    }
    // Wait until the solution root is live, then navigate.
    if (currentNode.node_id === config.manifest.root_node_id) {
      deepLinkApplied.current = target;
      void navigateTo(target, { history: "replace" });
    }
  }, [config, currentNode, navigateTo]);

  if (!config) {
    return null;
  }

  const downloadUrl =
    config.catalog.download_windows_url || WINDOWS_INSTALLER_FALLBACK;
  const board = Array.isArray(config.manifest.board)
    ? config.manifest.board.join(" ")
    : typeof config.manifest.board === "string"
      ? config.manifest.board
      : "";
  const scenario = board
    ? `${config.manifest.title} · ${board}`
    : config.manifest.title;

  async function onExampleChange(exampleId: string) {
    deepLinkApplied.current = null;
    await setDemoExample(exampleId);
    startPolling();
  }

  async function onVariantChange(variantId: string) {
    deepLinkApplied.current = null;
    await setDemoVariant(variantId);
    startPolling();
  }

  return (
    <div
      className="demo-banner"
      role="region"
      aria-label="Public demo"
      data-phone={phoneDemo ? "true" : "false"}
    >
      <div className="demo-banner__meta">
        <span className="demo-banner__badge" aria-label="Precomputed">
          Precomputed
        </span>
        <span className="demo-banner__desc muted" title={scenario}>
          {scenario}
        </span>
      </div>
      <div className="demo-banner__controls">
        <label className="demo-banner__field">
          <span className="muted">Example</span>
          <select
            aria-label="Demo example"
            value={config.exampleId}
            onChange={(event) => void onExampleChange(event.target.value)}
          >
            {config.catalog.examples.map((example) => (
              <option key={example.id} value={example.id}>
                {example.title}
              </option>
            ))}
          </select>
        </label>
        {config.manifest.variants.length > 1 ? (
          <label className="demo-banner__field">
            <span className="muted">Strategy</span>
            <select
              aria-label="Lock preset"
              value={config.variantId}
              onChange={(event) => void onVariantChange(event.target.value)}
            >
              {config.manifest.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {phoneDemo ? null : (
          <a
            className="demo-banner__download"
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
          >
            Download for Windows
          </a>
        )}
      </div>
      {phoneDemo ? (
        <div className="demo-banner__secondary">
          <a
            className="demo-banner__download-secondary"
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
          >
            Download for Windows
          </a>
        </div>
      ) : null}
    </div>
  );
}
