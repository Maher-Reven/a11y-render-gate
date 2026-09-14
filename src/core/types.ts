export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotStyles {
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  opacity: number;
  fontSize: number;
  fontWeight: number;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  outlineOffset: number;
  boxShadow: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: string;
  cursor: string;
  pointerEvents: string;
  display: string;
  visibility: string;
  position: string;
  textDecorationLine: string;
}

export interface SnapshotAttrs {
  id?: string;
  htmlFor?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
  ariaHidden?: string;
  role?: string;
  alt?: string;
  title?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  name?: string;
  className?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  tabindex?: number;
}

/**
 * One element as captured by the single in-page pass.
 *
 * Probes consume these as plain data, which is what lets them be unit-tested with
 * no browser at all — the fixture suite drives real probes over recorded
 * snapshots in milliseconds.
 */
export interface ElementSnapshot {
  /**
   * Index into the snapshot array; also stamped on the element as
   * `data-a11y-gate-idx`. The attribute keeps the shorter name on purpose: it is
   * an internal marker written to every captured element and never user-facing,
   * so brevity beats matching the package name.
   */
  idx: number;
  selector: string;
  tag: string;
  /** Trimmed text belonging to this element's own text nodes (not descendants'). */
  ownText: string;
  /** Trimmed full text content, truncated — used for labelling findings. */
  text: string;
  rect: Rect;
  styles: SnapshotStyles;
  /**
   * Background colours of this element and its ancestors, ordered
   * furthest-ancestor-first, for alpha compositing. Contains the literal computed
   * strings so the caller can detect gradients and bail to pixel sampling.
   */
  backgroundStack: string[];
  /** True if any layer in the stack is a gradient or image — compositing is unsafe. */
  hasImageBackground: boolean;
  /** Effective opacity including ancestors, which multiply. */
  effectiveOpacity: number;
  attrs: SnapshotAttrs;
  /** Natively interactive tag, interactive ARIA role, or a click affordance. */
  interactive: boolean;
  /** Reachable by Tab right now. */
  tabbable: boolean;
  /** Rendered, non-zero-size, not visibility:hidden, not aria-hidden. */
  visible: boolean;
  /** True when the element has no element children, i.e. it directly renders text. */
  isLeaf: boolean;
  /** True when this element sits inline inside a run of prose. */
  inlineInText: boolean;
  /**
   * Indices of this element's captured ancestors, nearest parent first.
   *
   * Probes need real DOM ancestry (is this inside a disabled fieldset? is that
   * other target my own child?). Inferring it from selector string prefixes is
   * wrong in both directions — `button.tiny-icon2` is not a descendant of
   * `button.tiny-icon` — so the relationship is recorded rather than guessed.
   */
  ancestorIdxs: number[];
}

export interface CollectResult {
  snapshots: ElementSnapshot[];
  /** Page-level context useful for reporting. */
  meta: {
    title: string;
    url: string;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    /** Document background, the base for compositing. */
    rootBackground: string;
    prefersColorScheme: string;
    elementsScanned: number;
    elementsSkipped: number;
  };
}

export type Theme = "light" | "dark";

export interface Viewport {
  name: string;
  width: number;
  height: number;
}
