import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Severity } from "./findings.js";
import type { Theme, Viewport } from "./types.js";

export interface RuleToggles {
  contrast?: { enabled?: boolean; reportDisabled?: boolean };
  "focus-visible"?: {
    enabled?: boolean;
    maxElements?: number;
    minIndicatorContrast?: number;
  };
  "target-size"?: { enabled?: boolean; minPx?: number };
  "label-wiring"?: { enabled?: boolean; strictPlaceholder?: boolean };
  "keyboard-reach"?: { enabled?: boolean; maxTabs?: number };
  "state-contrast"?: { enabled?: boolean };
  axe?: { enabled?: boolean };
}

export interface GateConfig {
  /** WCAG conformance level to hold text contrast to. */
  level: "AA" | "AAA";
  sources: {
    baseUrl?: string;
    storybookUrl?: string;
    /** Routes checked when the gate runs with no explicit target. */
    routes?: string[];
  };
  viewports: Viewport[];
  themes: Theme[];
  rules: RuleToggles;
  /** Selectors excluded entirely — third-party widgets you cannot fix. */
  ignore: string[];
  /** Severities at or above which the gate fails. */
  failOn: Severity[];
  /** Path to the accepted-debt file, relative to the config. */
  baseline: string;
  /** Where run artefacts are written. */
  outDir: string;
  /** Globs the Stop hook treats as UI work worth re-checking. */
  uiGlobs: string[];
  /** Resolved directory the config was found in. */
  rootDir: string;
}

export const DEFAULT_CONFIG: GateConfig = {
  level: "AA",
  sources: {},
  viewports: [{ name: "desktop", width: 1440, height: 900 }],
  themes: ["light"],
  rules: {},
  ignore: [],
  // Only the two severities that represent a real barrier block by default.
  // Blocking on `moderate` out of the box would make the gate feel arbitrary.
  failOn: ["critical", "serious"],
  baseline: ".a11y-render-gate/baseline.json",
  outDir: ".a11y-render-gate",
  uiGlobs: [
    "**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro",
    "**/*.css", "**/*.scss", "**/*.sass", "**/*.less", "**/*.html",
  ],
  rootDir: process.cwd(),
};

export const CONFIG_FILENAMES = ["a11y-render-gate.config.json", ".a11ygaterc.json"];

/** Walk up from `from` looking for a config file; returns null if none exists. */
export function findConfigFile(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load configuration, falling back to defaults.
 *
 * Presence of a config file is also the gate's opt-in signal: the Stop hook does
 * nothing in a project that has not configured one, so installing the plugin
 * never changes the behaviour of an unrelated repo.
 */
export function loadConfig(from: string = process.cwd()): GateConfig {
  const file = findConfigFile(from);
  if (!file) return { ...DEFAULT_CONFIG, rootDir: resolve(from) };

  let parsed: Partial<GateConfig> = {};
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    sources: { ...DEFAULT_CONFIG.sources, ...(parsed.sources ?? {}) },
    rules: { ...DEFAULT_CONFIG.rules, ...(parsed.rules ?? {}) },
    viewports: parsed.viewports?.length ? parsed.viewports : DEFAULT_CONFIG.viewports,
    themes: parsed.themes?.length ? parsed.themes : DEFAULT_CONFIG.themes,
    ignore: parsed.ignore ?? DEFAULT_CONFIG.ignore,
    failOn: parsed.failOn ?? DEFAULT_CONFIG.failOn,
    uiGlobs: parsed.uiGlobs ?? DEFAULT_CONFIG.uiGlobs,
    rootDir: dirname(file),
  };
}

export function hasConfig(from: string = process.cwd()): boolean {
  return findConfigFile(from) !== null;
}

export function ruleEnabled(config: GateConfig, rule: keyof RuleToggles): boolean {
  return config.rules[rule]?.enabled !== false;
}
