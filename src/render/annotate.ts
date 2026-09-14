import type { Page } from "playwright";
import { IDX_ATTR } from "../core/collect.js";
import type { Finding } from "../core/findings.js";
import type { CollectResult } from "../core/types.js";

const OVERLAY_ID = "a11y-render-gate-overlay";

export interface AnnotateOptions {
  /** Max boxes drawn; beyond this the image stops communicating anything. */
  maxBoxes?: number;
  fullPage?: boolean;
}

/**
 * Draw numbered boxes over the offending elements and screenshot the result.
 *
 * The numbers correspond to `screenshotRef` on each finding, so the text report
 * and the image refer to each other. An un-annotated screenshot is close to
 * useless here — it shows a page that looks fine, which is precisely the problem
 * being reported.
 */
export async function annotatedScreenshot(
  page: Page,
  findings: Finding[],
  collected: CollectResult,
  options: AnnotateOptions = {},
): Promise<{ png: Buffer; labelled: Finding[] }> {
  const { maxBoxes = 8, fullPage = false } = options;

  const selectorToIdx = new Map(collected.snapshots.map((s) => [s.selector, s.idx]));

  const labelled: Finding[] = [];
  const boxes: { idx: number; ref: number; severity: string }[] = [];

  for (const f of findings) {
    if (boxes.length >= maxBoxes) break;
    const idx = selectorToIdx.get(f.selector);
    if (idx === undefined) continue;
    const ref = boxes.length + 1;
    boxes.push({ idx, ref, severity: f.severity });
    labelled.push({ ...f, screenshotRef: ref });
  }

  await page.evaluate(
    ({ boxes, attr, overlayId }) => {
      document.getElementById(overlayId)?.remove();

      const overlay = document.createElement("div");
      overlay.id = overlayId;
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "2147483647",
      });

      const colors: Record<string, string> = {
        critical: "#e5484d",
        serious: "#e5a23d",
        moderate: "#3d7ae5",
        advice: "#8b8b8b",
      };

      for (const box of boxes) {
        const el = document.querySelector(`[${attr}="${box.idx}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const color = colors[box.severity] ?? "#e5484d";

        const frame = document.createElement("div");
        Object.assign(frame.style, {
          position: "absolute",
          left: `${r.left - 2}px`,
          top: `${r.top - 2}px`,
          width: `${r.width + 4}px`,
          height: `${r.height + 4}px`,
          border: `2px solid ${color}`,
          borderRadius: "2px",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.9)",
        });

        const badge = document.createElement("div");
        badge.textContent = String(box.ref);
        Object.assign(badge.style, {
          position: "absolute",
          // Above the box, unless that would run off the top of the viewport.
          left: `${Math.max(0, r.left - 2)}px`,
          top: `${r.top - 20 < 0 ? r.bottom + 4 : r.top - 20}px`,
          background: color,
          color: "#ffffff",
          font: "600 12px/16px ui-monospace, monospace",
          padding: "1px 6px",
          borderRadius: "3px",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.9)",
        });

        overlay.appendChild(frame);
        overlay.appendChild(badge);
      }

      document.body.appendChild(overlay);
    },
    { boxes, attr: IDX_ATTR, overlayId: OVERLAY_ID },
  );

  const png = await page.screenshot({ fullPage, animations: "disabled" });

  await page.evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_ID);

  return { png, labelled };
}
