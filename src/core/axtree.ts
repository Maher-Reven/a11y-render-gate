import type { Page } from "playwright";
import { IDX_ATTR } from "./collect.js";

export interface AxNameSource {
  type: string;
  value?: { value?: unknown };
  attribute?: string;
  attributeValue?: { value?: unknown };
  superseded?: boolean;
  nativeSource?: string;
  invalid?: boolean;
  invalidReason?: string;
}

export interface AxNode {
  /** Index from our collect pass, when this AX node maps to a captured element. */
  idx: number | null;
  role: string;
  /** The accessible name as a screen reader would announce it. */
  name: string;
  /**
   * Ordered record of every naming mechanism the browser tried and what each
   * yielded. This is the single most useful artefact in the whole check: it says
   * not just that a name is missing but which mechanism was expected to provide
   * it and why it came back empty.
   */
  nameSources: AxNameSource[];
  description: string;
  ignored: boolean;
  ignoredReasons: string[];
  properties: Record<string, unknown>;
}

/**
 * Read the accessibility tree Chromium actually computed, and join it back to the
 * elements we snapshotted.
 *
 * Re-implementing accessible-name computation in userland is a well-known way to
 * be subtly wrong: the algorithm has a dozen fallbacks, and the browser has
 * already run it correctly. Asking the browser what the name *is* beats deriving
 * what it *should* be.
 */
export async function readAxTree(page: Page): Promise<AxNode[]> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Accessibility.enable");
    await client.send("DOM.enable");

    const { root } = (await client.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as any;

    // backendNodeId -> our collect-pass index, via the marker attribute.
    const backendToIdx = new Map<number, number>();
    const walk = (node: any) => {
      if (!node) return;
      const attrs: string[] = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === IDX_ATTR) {
          const parsed = parseInt(attrs[i + 1] ?? "", 10);
          if (!Number.isNaN(parsed)) backendToIdx.set(node.backendNodeId, parsed);
        }
      }
      for (const child of node.children ?? []) walk(child);
      for (const child of node.shadowRoots ?? []) walk(child);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);

    const { nodes } = (await client.send("Accessibility.getFullAXTree")) as any;

    return (nodes as any[]).map((n) => {
      const properties: Record<string, unknown> = {};
      for (const p of n.properties ?? []) {
        properties[p.name] = p.value?.value;
      }
      return {
        idx: n.backendDOMNodeId != null ? backendToIdx.get(n.backendDOMNodeId) ?? null : null,
        role: String(n.role?.value ?? ""),
        name: String(n.name?.value ?? ""),
        nameSources: (n.name?.sources ?? []) as AxNameSource[],
        description: String(n.description?.value ?? ""),
        ignored: Boolean(n.ignored),
        ignoredReasons: (n.ignoredReasons ?? []).map((r: any) => String(r.name ?? "")),
        properties,
      };
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Index AX nodes by our snapshot index, dropping those that map to nothing. */
export function indexByElement(nodes: AxNode[]): Map<number, AxNode> {
  const map = new Map<number, AxNode>();
  for (const n of nodes) {
    if (n.idx === null) continue;
    // The first non-ignored node wins; an ignored duplicate would mask a real name.
    const existing = map.get(n.idx);
    if (!existing || (existing.ignored && !n.ignored)) map.set(n.idx, n);
  }
  return map;
}

/**
 * Which naming mechanism was *attempted* but produced nothing.
 *
 * Distinguishes "this control has no name and nothing was tried" from "you wired
 * up aria-labelledby and it resolved to nothing" — very different fixes.
 */
export function attemptedButEmpty(node: AxNode): string[] {
  const attempted: string[] = [];
  for (const src of node.nameSources) {
    const value = src.value?.value ?? src.attributeValue?.value;
    const hasValue = typeof value === "string" ? value.trim().length > 0 : value != null;
    if (!hasValue && (src.attribute || src.nativeSource)) {
      attempted.push(src.attribute ?? src.nativeSource ?? src.type);
    }
  }
  return attempted;
}
