import type { Page } from "playwright";
import { IDX_ATTR } from "../core/collect.js";
import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type Finding } from "../core/findings.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

export interface KeyboardReachOptions {
  /** Cap on Tab presses when walking the page. */
  maxTabs?: number;
}

export interface TabWalkResult {
  /** Snapshot indices in the order Tab visited them. */
  order: number[];
  /** True if Tab cycled without escaping a subtree. */
  trapped: boolean;
  trapSelector?: string;
}

/**
 * Keyboard operability: what Tab can actually reach, and in what order.
 *
 * `<div onClick>` is the signature failure of generated UI — it looks and behaves
 * correctly with a mouse and is completely unusable without one. Because React
 * and friends attach listeners at the root rather than on the element, a DOM
 * inspection cannot see the handler; this probe confirms handlers through CDP,
 * where they are visible regardless of how the framework bound them.
 */
export async function keyboardReachProbe(
  page: Page,
  collected: CollectResult,
  options: KeyboardReachOptions = {},
): Promise<{ findings: Finding[]; walk: TabWalkResult }> {
  const { maxTabs = 60 } = options;
  const findings: Finding[] = [];

  const clickable = await findClickHandlers(page, collected);

  for (const s of collected.snapshots) {
    if (!s.visible) continue;

    // --- Interactive but unreachable ---------------------------------------
    const hasHandler = clickable.has(s.idx);
    const looksInteractive = hasHandler || s.styles.cursor === "pointer";
    const isNativelyInteractive = [
      "a", "button", "input", "select", "textarea", "summary",
    ].includes(s.tag);

    if (
      looksInteractive &&
      !s.tabbable &&
      !isNativelyInteractive &&
      !hasInteractiveRole(s) &&
      // A pointer cursor on a big container is usually decorative, not a control.
      s.rect.w * s.rect.h < 120_000
    ) {
      findings.push({
        id: makeFindingId("keyboard-reach", s.selector, "unreachable"),
        rule: "keyboard-reach",
        severity: hasHandler ? "critical" : "serious",
        wcag: ["2.1.1 Keyboard (A)", "4.1.2 Name, Role, Value (A)"],
        selector: s.selector,
        label: describeElement(s),
        facts: {
          tag: s.tag,
          hasClickHandler: hasHandler,
          cursor: s.styles.cursor,
          tabbable: false,
          role: s.attrs.role ?? "(none)",
          verdict: "responds to a mouse click but Tab can never reach it",
        },
        fix: {
          summary: `Use a <button> instead of <${s.tag}>, or add role="button" plus tabindex="0" and a keyboard handler.`,
          html: `<button type="button">${s.ownText || "…"}</button>`,
        },
        sourceHint: sourceHint(s),
      });
    }

    // --- Positive tabindex --------------------------------------------------
    if (typeof s.attrs.tabindex === "number" && s.attrs.tabindex > 0) {
      findings.push({
        id: makeFindingId("keyboard-reach", s.selector, "positive-tabindex"),
        rule: "keyboard-reach",
        severity: "moderate",
        wcag: ["2.4.3 Focus Order (A)"],
        selector: s.selector,
        label: describeElement(s),
        facts: {
          tabindex: s.attrs.tabindex,
          verdict: "a positive tabindex jumps ahead of every other control on the page",
        },
        fix: {
          summary: 'Use tabindex="0" and order the DOM to match the visual order instead.',
          html: 'tabindex="0"',
        },
        sourceHint: sourceHint(s),
      });
    }
  }

  const walk = await tabWalk(page, maxTabs);

  if (walk.trapped) {
    findings.push({
      id: makeFindingId("keyboard-reach", walk.trapSelector ?? "document", "focus-trap"),
      rule: "keyboard-reach",
      severity: "critical",
      wcag: ["2.1.2 No Keyboard Trap (A)"],
      selector: walk.trapSelector ?? "document",
      label: "keyboard focus trap",
      facts: {
        tabsBeforeTrap: walk.order.length,
        verdict: "Tab cycles within a subtree and cannot leave it",
      },
      fix: {
        summary:
          "Ensure Tab and Shift+Tab can move past this region; if it is a modal, close it on Escape and restore focus.",
      },
    });
  }

  const outOfOrder = detectVisualOrderMismatch(walk.order, collected);
  if (outOfOrder) findings.push(outOfOrder);

  return { findings, walk };
}

function hasInteractiveRole(s: ElementSnapshot): boolean {
  const role = s.attrs.role;
  if (!role) return false;
  return ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option"].includes(
    role,
  );
}

/**
 * Ask the browser which elements have click listeners attached.
 *
 * `DOMDebugger.getEventListeners` sees listeners regardless of how they were
 * registered, which is the only way to catch framework-bound handlers. It costs
 * one CDP round trip per element, so it is run only over plausible candidates.
 */
async function findClickHandlers(
  page: Page,
  collected: CollectResult,
): Promise<Set<number>> {
  const found = new Set<number>();

  const candidates = collected.snapshots.filter(
    (s) =>
      s.visible &&
      !s.tabbable &&
      !["a", "button", "input", "select", "textarea", "summary"].includes(s.tag) &&
      (s.styles.cursor === "pointer" || s.attrs.role !== undefined || s.isLeaf),
  );
  if (candidates.length === 0) return found;

  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("Runtime.enable");

    for (const s of candidates.slice(0, 150)) {
      try {
        const evaluated = (await client.send("Runtime.evaluate", {
          expression: `document.querySelector('[${IDX_ATTR}="${s.idx}"]')`,
          returnByValue: false,
        })) as any;
        const objectId = evaluated?.result?.objectId;
        if (!objectId) continue;

        const listeners = (await client.send("DOMDebugger.getEventListeners", {
          objectId,
        })) as any;
        const hasClick = (listeners?.listeners ?? []).some(
          (l: any) => l.type === "click" || l.type === "mousedown" || l.type === "keydown",
        );
        if (hasClick) found.add(s.idx);
        await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
      } catch {
        // One element failing to resolve should not abort the probe.
      }
    }
  } finally {
    await client.detach().catch(() => {});
  }

  return found;
}

/** Drive real Tab presses and record where focus lands. */
async function tabWalk(page: Page, maxTabs: number): Promise<TabWalkResult> {
  const order: number[] = [];
  const seen = new Set<number>();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body?.focus();
  });

  let trapped = false;
  let trapSelector: string | undefined;
  let repeats = 0;

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    const idx = await page.evaluate((attr) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const raw = el.getAttribute(attr);
      return raw === null ? -1 : parseInt(raw, 10);
    }, IDX_ATTR);

    if (idx === null) break;
    if (idx === -1) continue;

    if (seen.has(idx)) {
      repeats++;
      // Revisiting is normal once the cycle wraps; only a tight cycle that never
      // reaches anything new looks like a trap.
      if (repeats > 3 && order.length > 0 && new Set(order.slice(-4)).size <= 2) {
        trapped = true;
        break;
      }
      if (repeats > order.length + 2) break;
      continue;
    }

    seen.add(idx);
    order.push(idx);
  }

  if (trapped) {
    const last = order[order.length - 1];
    trapSelector = last !== undefined ? String(last) : undefined;
  }

  return { order, trapped, trapSelector };
}

/**
 * Tab order that contradicts the visual order.
 *
 * Reported once for the page rather than per element: the fix is a single
 * reordering, and one finding that names the worst jump is more actionable than
 * twenty that describe its consequences.
 */
function detectVisualOrderMismatch(
  order: number[],
  collected: CollectResult,
): Finding | null {
  if (order.length < 3) return null;

  const positions = order
    .map((idx) => collected.snapshots.find((s) => s.idx === idx))
    .filter((s): s is ElementSnapshot => s !== undefined);

  let worst: { from: ElementSnapshot; to: ElementSnapshot; delta: number } | null = null;

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!;
    const cur = positions[i]!;
    // A jump upward by more than a row height, with no intervening column change,
    // is the signature of a DOM order that does not match what is on screen.
    const verticalJump = prev.rect.y - cur.rect.y;
    if (verticalJump > 40) {
      if (!worst || verticalJump > worst.delta) {
        worst = { from: prev, to: cur, delta: verticalJump };
      }
    }
  }

  if (!worst) return null;

  return {
    id: makeFindingId("keyboard-reach", worst.to.selector, "tab-order"),
    rule: "keyboard-reach",
    severity: "moderate",
    wcag: ["2.4.3 Focus Order (A)"],
    selector: worst.to.selector,
    label: describeElement(worst.to),
    facts: {
      previousTarget: describeElement(worst.from),
      jumpUpPx: Math.round(worst.delta),
      verdict: "Tab order jumps back up the page, so focus does not follow the visual order",
    },
    fix: {
      summary:
        "Reorder the DOM to match the visual order, or move the element so its position matches its place in the sequence.",
    },
  };
}
