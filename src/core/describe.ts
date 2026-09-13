import type { ElementSnapshot } from "./types.js";

/**
 * A short handle a human recognises on sight: `button "Continue"`, `input#email`.
 *
 * Findings are read in a terminal next to a diff, so the label has to identify the
 * element faster than the CSS selector does. The selector is still carried
 * separately for machine use.
 */
export function describeElement(s: ElementSnapshot): string {
  const text = (s.ownText || s.text).trim();
  if (text) {
    const clipped = text.length > 40 ? `${text.slice(0, 37)}…` : text;
    return `${s.tag} "${clipped}"`;
  }
  if (s.attrs.ariaLabel) return `${s.tag} [aria-label="${s.attrs.ariaLabel}"]`;
  if (s.attrs.alt) return `${s.tag} [alt="${s.attrs.alt}"]`;
  if (s.attrs.placeholder) return `${s.tag} [placeholder="${s.attrs.placeholder}"]`;
  if (s.attrs.name) return `${s.tag}[name="${s.attrs.name}"]`;
  if (s.attrs.id) return `${s.tag}#${s.attrs.id}`;
  if (s.attrs.type) return `${s.tag}[type="${s.attrs.type}"]`;
  return s.tag;
}

/**
 * Where the offending value probably came from in source.
 *
 * Utility classes are the single most common origin of these defects in
 * agent-written UI, and naming the class turns "change this colour" into a
 * findable string in the file. Deliberately reports the classes as they are
 * rather than mapping them to palette values — a wrong mapping is worse than none.
 */
export function sourceHint(s: ElementSnapshot): string | undefined {
  const cls = s.attrs.className?.trim();
  if (!cls) return undefined;
  const classes = cls.split(/\s+/).filter(Boolean);
  if (classes.length === 0) return undefined;
  const shown = classes.slice(0, 6).join(" ");
  return `class="${shown}${classes.length > 6 ? " …" : ""}"`;
}
