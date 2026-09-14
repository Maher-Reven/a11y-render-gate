import type { Page } from "playwright";
import { GateError } from "./errors.js";
import type { CollectResult } from "./types.js";

export const IDX_ATTR = "data-a11y-gate-idx";

export interface CollectOptions {
  /** Hard cap on elements captured; pathological pages shouldn't stall the gate. */
  maxElements?: number;
  /** Selectors to skip entirely (third-party widgets, ad slots). */
  ignore?: string[];
  /**
   * Restrict the scan to one subtree, e.g. the component you just changed on an
   * otherwise large page. Ancestors outside the scope are still walked for
   * background compositing, because what a colour renders against does not stop
   * mattering just because you narrowed the report.
   */
  within?: string;
}

/**
 * The single in-page pass.
 *
 * Everything the probes need is gathered here in one `evaluate` round-trip, and
 * every probe downstream is a pure function over the result. That is the main
 * structural bet of this tool: it keeps a full check to one DOM traversal instead
 * of N, and it makes probes testable against recorded snapshots with no browser.
 *
 * Side effect: stamps `data-a11y-gate-idx` on each captured element so later
 * phases (accessibility tree join, focus diffing, annotation) can find the exact
 * same element again without re-deriving selectors.
 */
export async function collect(
  page: Page,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const { maxElements = 3000, ignore = [], within } = options;

  const result = (await page.evaluate(
    ({ maxElements, ignore, IDX_ATTR, within }) => {
      const SKIP_TAGS = new Set([
        "script", "style", "meta", "link", "head", "title", "noscript",
        "template", "br", "source", "track", "param", "base",
      ]);

      const INTERACTIVE_ROLES = new Set([
        "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
        "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton",
        "textbox", "combobox", "searchbox", "listbox", "treeitem", "gridcell",
      ]);

      const NATIVE_INTERACTIVE = new Set([
        "a", "button", "input", "select", "textarea", "summary", "details",
        "audio", "video", "iframe",
      ]);

      const esc = (s: string) =>
        (window as any).CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");

      const uniqueId = (el: Element): string | null => {
        const id = el.getAttribute("id");
        if (!id) return null;
        try {
          return document.querySelectorAll(`#${esc(id)}`).length === 1 ? `#${esc(id)}` : null;
        } catch {
          return null;
        }
      };

      /** A class selector, when exactly one element in the document matches it. */
      const uniqueClass = (el: Element): string | null => {
        const raw = typeof el.className === "string" ? el.className.trim() : "";
        if (!raw) return null;
        for (const cls of raw.split(/\s+/)) {
          // Utility classes (p-2, flex, w-full) are shared by construction and
          // never identify one element; skip straight past them.
          if (!cls || cls.length < 3) continue;
          try {
            const sel = `${el.tagName.toLowerCase()}.${esc(cls)}`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch {
            continue;
          }
        }
        return null;
      };

      /** Shortest stable path we can re-query later; ids short-circuit it. */
      const cssPath = (el: Element): string => {
        const direct = uniqueId(el);
        if (direct) return direct;
        const byClass = uniqueClass(el);
        if (byClass) return byClass;
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
          const anchor = uniqueId(cur);
          if (anchor) {
            parts.unshift(anchor);
            break;
          }
          let part = cur.tagName.toLowerCase();
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter(
              (c) => c.tagName === cur!.tagName,
            );
            if (sameTag.length > 1) {
              part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
            }
          }
          parts.unshift(part);
          if (cur.tagName === "BODY" || cur.tagName === "HTML") break;
          cur = cur.parentElement;
        }
        return parts.join(" > ");
      };

      const isTabbable = (el: Element, style: CSSStyleDeclaration): boolean => {
        if (style.display === "none" || style.visibility === "hidden") return false;
        const anyEl = el as HTMLElement & { type?: string; isContentEditable?: boolean };
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        const tiRaw = el.getAttribute("tabindex");
        if (tiRaw !== null) {
          const n = parseInt(tiRaw, 10);
          return !Number.isNaN(n) && n >= 0;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "a" || tag === "area") return el.hasAttribute("href");
        if (tag === "input") return anyEl.type !== "hidden";
        if (tag === "button" || tag === "select" || tag === "textarea") return true;
        if (tag === "summary") return el.parentElement?.tagName.toLowerCase() === "details";
        if (tag === "iframe") return true;
        if (anyEl.isContentEditable) return true;
        return false;
      };

      /**
       * Click handlers as the framework stored them.
       *
       * React and Vue keep props on internal, version-suffixed keys attached to
       * the DOM node. Reading those is the only reliable way to see a JSX
       * onClick, because the listener itself lives on the root container.
       */
      const frameworkHandler = (el: Element): boolean => {
        const anyEl = el as any;
        for (const key of Object.keys(anyEl)) {
          if (key.startsWith("__reactProps$") || key.startsWith("__reactEventHandlers$")) {
            const props = anyEl[key];
            if (props && (typeof props.onClick === "function" || typeof props.onKeyDown === "function")) {
              return true;
            }
          }
        }
        // Vue 3 keeps the vnode on the element; its props carry the listeners.
        const vnode = anyEl.__vnode;
        if (vnode?.props && (vnode.props.onClick || vnode.props.onclick)) return true;
        return false;
      };

      const NATIVE_FOCUSABLE = new Set(["a", "button", "input", "select", "textarea", "summary"]);

      const hasClickAffordance = (el: Element, style: CSSStyleDeclaration): boolean => {
        // `onclick` as an attribute or property is the reliable half; `cursor:
        // pointer` on a non-interactive tag is the heuristic half. React attaches
        // listeners at the root, so neither catches JSX handlers — the
        // keyboard-reach probe confirms those via CDP, where it matters.
        if (el.hasAttribute("onclick")) return true;
        if ((el as HTMLElement).onclick) return true;
        return style.cursor === "pointer";
      };

      const ignoreMatches = (el: Element): boolean =>
        ignore.some((sel) => {
          try {
            return el.matches(sel) || el.closest(sel) !== null;
          } catch {
            return false;
          }
        });

      const snapshots: any[] = [];
      let skipped = 0;

      const scope = within ? document.querySelector(within) : document.body;
      if (!scope) return { scopeMissing: true };
      const all = Array.from(scope.querySelectorAll("*"));
      // Include the scope root itself: it usually carries the background.
      all.unshift(scope);

      for (const el of all) {
        if (snapshots.length >= maxElements) {
          skipped += 1;
          continue;
        }
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (ignoreMatches(el)) {
          skipped += 1;
          continue;
        }

        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        // aria-hidden anywhere up the chain removes it from the a11y tree entirely.
        const ariaHidden = el.closest('[aria-hidden="true"]') !== null;

        const visible =
          r.width > 0 &&
          r.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity || "1") > 0.01 &&
          !ariaHidden;

        // Build the background stack and effective opacity in one ancestor walk.
        const backgroundStack: string[] = [];
        let hasImageBackground = false;
        let effectiveOpacity = 1;
        {
          let cur: Element | null = el;
          const chain: Element[] = [];
          while (cur && cur.nodeType === 1) {
            chain.push(cur);
            cur = cur.parentElement;
          }
          // Furthest ancestor first, so `flatten` can composite in paint order.
          for (let i = chain.length - 1; i >= 0; i--) {
            const cs = getComputedStyle(chain[i]!);
            const bg = cs.backgroundColor;
            if (cs.backgroundImage && cs.backgroundImage !== "none") hasImageBackground = true;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
              backgroundStack.push(bg);
            }
            const op = parseFloat(cs.opacity || "1");
            if (!Number.isNaN(op)) effectiveOpacity *= op;
          }
        }

        let ownText = "";
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === 3) ownText += node.textContent ?? "";
        }
        ownText = ownText.replace(/\s+/g, " ").trim();

        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

        const anyEl = el as HTMLElement & {
          type?: string; disabled?: boolean; readOnly?: boolean;
          required?: boolean; htmlFor?: string;
        };

        const role = el.getAttribute("role");
        const interactive =
          NATIVE_INTERACTIVE.has(tag) ||
          (role !== null && INTERACTIVE_ROLES.has(role)) ||
          isTabbable(el, style) ||
          hasClickAffordance(el, style);

        // "Inline inside prose" powers the WCAG 2.2 target-size inline exception,
        // whose wording is that the target sits in a sentence or is constrained by
        // the line-height of surrounding non-target text.
        //
        // Comparing against the *immediate* parent is not enough: a link wrapped
        // in a tight inline span (`<span><a>↑</a></span>`) has a parent whose text
        // is just the link, so it reads as standalone and gets flagged — which is
        // how Wikipedia's citation backlinks produced dozens of false failures.
        // The containing block is what actually holds the sentence.
        let blockAncestor: Element | null = el.parentElement;
        while (
          blockAncestor &&
          getComputedStyle(blockAncestor).display.startsWith("inline")
        ) {
          blockAncestor = blockAncestor.parentElement;
        }
        const surroundingText = (blockAncestor?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const inlineInText =
          (style.display === "inline" || style.display === "inline-block") &&
          surroundingText.length > text.length + 10;

        const idx = snapshots.length;

        const ancestorIdxs: number[] = [];
        for (let a = el.parentElement; a; a = a.parentElement) {
          const raw = a.getAttribute(IDX_ATTR);
          if (raw === null) continue;
          const parsed = parseInt(raw, 10);
          if (!Number.isNaN(parsed)) ancestorIdxs.push(parsed);
        }

        el.setAttribute(IDX_ATTR, String(idx));

        const tiAttr = el.getAttribute("tabindex");

        // A control nested inside another control is not a separate target: the
        // span inside a link is the link, and flagging it is noise.
        let hasInteractiveAncestor = false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const tag = a.tagName.toLowerCase();
          if (NATIVE_FOCUSABLE.has(tag) || a.hasAttribute("tabindex") || a.getAttribute("role") === "button") {
            hasInteractiveAncestor = true;
            break;
          }
        }

        snapshots.push({
          idx,
          selector: cssPath(el),
          tag,
          ownText,
          text,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          styles: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            opacity: parseFloat(style.opacity || "1"),
            fontSize: parseFloat(style.fontSize || "16"),
            fontWeight: parseInt(style.fontWeight || "400", 10) || 400,
            outlineStyle: style.outlineStyle,
            outlineWidth: parseFloat(style.outlineWidth || "0"),
            outlineColor: style.outlineColor,
            outlineOffset: parseFloat(style.outlineOffset || "0"),
            boxShadow: style.boxShadow,
            borderColor: style.borderColor,
            borderWidth: parseFloat(style.borderTopWidth || "0"),
            borderRadius: style.borderRadius,
            cursor: style.cursor,
            pointerEvents: style.pointerEvents,
            display: style.display,
            visibility: style.visibility,
            position: style.position,
            textDecorationLine: style.textDecorationLine,
          },
          backgroundStack,
          hasImageBackground,
          effectiveOpacity,
          attrs: {
            id: el.getAttribute("id") ?? undefined,
            htmlFor: el.getAttribute("for") ?? undefined,
            ariaLabel: el.getAttribute("aria-label") ?? undefined,
            ariaLabelledby: el.getAttribute("aria-labelledby") ?? undefined,
            ariaDescribedby: el.getAttribute("aria-describedby") ?? undefined,
            ariaHidden: el.getAttribute("aria-hidden") ?? undefined,
            role: role ?? undefined,
            alt: el.getAttribute("alt") ?? undefined,
            title: el.getAttribute("title") ?? undefined,
            placeholder: el.getAttribute("placeholder") ?? undefined,
            type: el.getAttribute("type") ?? undefined,
            href: el.getAttribute("href") ?? undefined,
            name: el.getAttribute("name") ?? undefined,
            className: typeof el.className === "string" ? el.className : undefined,
            disabled: el.hasAttribute("disabled") || anyEl.disabled === true,
            readOnly: anyEl.readOnly === true,
            required: el.hasAttribute("required"),
            tabindex: tiAttr === null ? undefined : parseInt(tiAttr, 10),
          },
          interactive,
          frameworkClickHandler: frameworkHandler(el),
          hasInteractiveAncestor,
          tabbable: isTabbable(el, style),
          visible,
          isLeaf: el.children.length === 0,
          inlineInText,
          ancestorIdxs,
        });
      }

      // The compositing base for every contrast calculation. `html` is transparent
      // by default and `body` usually carries the real page background, so take
      // the first layer that is actually opaque rather than the first that exists
      // — "rgba(0, 0, 0, 0)" is a truthy string and silently poisons the base.
      const isTransparent = (c: string) =>
        !c || c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : "";
      const rootBg = !isTransparent(htmlBg)
        ? htmlBg
        : !isTransparent(bodyBg)
          ? bodyBg
          : // Chromium paints an unstyled canvas white; match what the user sees.
            "rgb(255, 255, 255)";

      return {
        snapshots,
        meta: {
          title: document.title,
          url: location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          devicePixelRatio: window.devicePixelRatio,
          rootBackground: rootBg,
          prefersColorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
          elementsScanned: snapshots.length,
          elementsSkipped: skipped,
        },
      };
    },
    { maxElements, ignore, IDX_ATTR, within },
  )) as CollectResult | { scopeMissing: true };

  if ('scopeMissing' in result) {
    throw new GateError(
      `Nothing on the page matches within="${within}".`,
      'Check the selector, or drop it to check the whole page.',
    );
  }
  return result;
}

/** Remove our marker attributes — matters when the page under test is a real app. */
export async function cleanup(page: Page): Promise<void> {
  await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
  }, IDX_ATTR);
}
