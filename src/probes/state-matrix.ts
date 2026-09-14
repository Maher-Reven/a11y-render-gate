import type { Page } from "playwright";
import {
  compositeOver,
  contrastRatio,
  flatten,
  formatColor,
  parseColor,
  requiredRatio,
  roundRatio,
  suggestForeground,
  type Rgba,
} from "../core/color.js";
import { IDX_ATTR } from "../core/collect.js";
import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type ProbeFinding as Finding } from "../core/findings.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

export type UiState = "hover" | "focus" | "active";

export interface StateMatrixOptions {
  states?: UiState[];
  /** Cap on elements tested; each state costs a CDP round trip. */
  maxElements?: number;
  level?: "AA" | "AAA";
}

/**
 * Contrast in the states nobody looks at.
 *
 * A palette is chosen and checked at rest. The hover colour is picked by eye
 * afterwards, and never measured by anyone — so `:hover { color: #999 }` on a
 * white card ships, and the control becomes unreadable exactly while the user is
 * pointing at it.
 *
 * States are forced through CDP rather than by moving a real mouse: forcing is
 * deterministic, cannot trigger scroll or layout side effects, and works for
 * elements the pointer could not reach anyway.
 */
export async function stateMatrixProbe(
  page: Page,
  collected: CollectResult,
  options: StateMatrixOptions = {},
): Promise<Finding[]> {
  const { states = ["hover", "focus"], maxElements = 30, level = "AA" } = options;

  const candidates = collected.snapshots.filter(
    (s) => s.visible && s.interactive && s.attrs.disabled !== true,
  );
  if (candidates.length === 0) return [];

  const findings: Finding[] = [];
  const client = await page.context().newCDPSession(page);

  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = (await client.send("DOM.getDocument", { depth: 1 })) as any;

    for (const s of candidates.slice(0, maxElements)) {
      let nodeId: number | undefined;
      try {
        const found = (await client.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `[${IDX_ATTR}="${s.idx}"]`,
        })) as any;
        nodeId = found?.nodeId;
      } catch {
        continue;
      }
      if (!nodeId) continue;

      for (const state of states) {
        try {
          await client.send("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: [state],
          });

          const measured = await readColors(page, s.idx);
          if (!measured) continue;

          const finding = evaluateState(s, measured, state, collected, level);
          if (finding) findings.push(finding);
        } catch {
          // A state that cannot be forced is not a defect.
        } finally {
          await client
            .send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })
            .catch(() => {});
        }
      }
    }
  } finally {
    await client.detach().catch(() => {});
  }

  return findings;
}

interface MeasuredColors {
  color: string;
  backgroundStack: string[];
  effectiveOpacity: number;
  fontSize: number;
  fontWeight: number;
  ownText: string;
}

async function readColors(page: Page, idx: number): Promise<MeasuredColors | null> {
  return page.evaluate(
    ({ idx, attr }) => {
      const el = document.querySelector(`[${attr}="${idx}"]`);
      if (!el) return null;
      const style = getComputedStyle(el);

      const backgroundStack: string[] = [];
      let effectiveOpacity = 1;
      const chain: Element[] = [];
      for (let cur: Element | null = el; cur; cur = cur.parentElement) chain.push(cur);
      for (let i = chain.length - 1; i >= 0; i--) {
        const cs = getComputedStyle(chain[i]!);
        const bg = cs.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") backgroundStack.push(bg);
        const op = parseFloat(cs.opacity || "1");
        if (!Number.isNaN(op)) effectiveOpacity *= op;
      }

      let ownText = "";
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) ownText += node.textContent ?? "";
      }

      return {
        color: style.color,
        backgroundStack,
        effectiveOpacity,
        fontSize: parseFloat(style.fontSize || "16"),
        fontWeight: parseInt(style.fontWeight || "400", 10) || 400,
        ownText: ownText.replace(/\s+/g, " ").trim(),
      };
    },
    { idx, attr: IDX_ATTR },
  );
}

function evaluateState(
  s: ElementSnapshot,
  measured: MeasuredColors,
  state: UiState,
  collected: CollectResult,
  level: "AA" | "AAA",
): Finding | null {
  // The text may live on a child (a button wrapping a span). Fall back to the
  // snapshot's own text so a label-less wrapper is not silently skipped.
  const text = measured.ownText || s.ownText;
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;

  const rawFg = parseColor(measured.color);
  if (!rawFg) return null;

  const pageBase = parseColor(collected.meta.rootBackground) ?? { r: 255, g: 255, b: 255, a: 1 };
  const layers = measured.backgroundStack
    .map(parseColor)
    .filter((c): c is Rgba => c !== null);
  const background = flatten(layers, pageBase);
  const foreground = compositeOver(
    { ...rawFg, a: rawFg.a * measured.effectiveOpacity },
    background,
  );

  const required = requiredRatio(measured.fontSize, measured.fontWeight, level);
  const ratio = contrastRatio(foreground, background);
  if (ratio >= required) return null;

  const suggestion = suggestForeground(foreground, background, required);

  return {
    id: makeFindingId("state-contrast", s.selector, state),
    rule: "state-contrast",
    severity: ratio < 3 ? "serious" : "moderate",
    wcag: [level === "AAA" ? "1.4.6 Contrast (Enhanced) (AAA)" : "1.4.3 Contrast (Minimum) (AA)"],
    selector: s.selector,
    label: `${describeElement(s)} :${state}`,
    facts: {
      state,
      foreground: formatColor(foreground),
      background: formatColor(background),
      ratio: roundRatio(ratio),
      required,
      fontPx: Math.round(measured.fontSize * 10) / 10,
      fontWeight: measured.fontWeight,
      verdict: `contrast fails in the :${state} state, though it passes at rest`,
    },
    fix: suggestion
      ? {
          summary: `In :${state}, set color to ${suggestion.hex} (${suggestion.ratio}:1 against ${formatColor(background)}).`,
          css: `&:${state} {\n  color: ${suggestion.hex};\n}`,
        }
      : {
          summary: `The :${state} colours cannot reach ${required}:1 — change the ${state} background instead.`,
        },
    sourceHint: sourceHint(s),
  };
}
