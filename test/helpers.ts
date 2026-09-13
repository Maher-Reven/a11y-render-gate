import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { closeBrowser, createSession, type Session } from "../src/core/browser.js";
import { collect } from "../src/core/collect.js";
import { loadSource } from "../src/sources/index.js";
import type { CollectResult } from "../src/core/types.js";
import type { Finding } from "../src/core/findings.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "fixtures");

export function fixture(relative: string): string {
  return readFileSync(join(FIXTURES, relative), "utf8");
}

export interface RenderedFixture {
  session: Session;
  collected: CollectResult;
}

/**
 * Render a fixture and take the single collection pass over it.
 *
 * Tests that only need snapshots can then run probes as pure functions; tests for
 * focus visibility keep the session open because they must drive the page.
 */
export async function render(relative: string): Promise<RenderedFixture> {
  const session = await createSession();
  await loadSource(session, { kind: "html", html: fixture(relative) });
  const collected = await collect(session.page);
  return { session, collected };
}

export async function shutdown(): Promise<void> {
  await closeBrowser();
}

/** Findings on elements matching a class, for asserting against fixture `expect:` blocks. */
export function byClass(findings: Finding[], className: string): Finding[] {
  return findings.filter(
    (f) => f.sourceHint?.includes(className) || f.selector.includes(className),
  );
}

export function selectorsOf(findings: Finding[]): string[] {
  return findings.map((f) => f.selector);
}

/** Map findings to the class names they landed on — the fixtures key on classes. */
export function classesOf(findings: Finding[], collected: CollectResult): string[] {
  return findings.map((f) => {
    const snap = collected.snapshots.find((s) => s.selector === f.selector);
    const cls = snap?.attrs.className?.trim().split(/\s+/)[0];
    return cls ?? f.selector;
  });
}
