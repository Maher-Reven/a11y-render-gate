import { attemptedButEmpty, indexByElement, type AxNode } from "../core/axtree.js";
import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type ProbeFinding as Finding, type Severity } from "../core/findings.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

/** Controls that must carry an accessible name to be operable. */
const MUST_BE_NAMED = new Set([
  "button", "link", "checkbox", "radio", "switch", "textbox", "combobox",
  "searchbox", "listbox", "slider", "spinbutton", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "option", "treeitem",
]);

const NAMED_BY_TAG = new Set(["input", "select", "textarea", "button", "a"]);

export interface LabelWiringOptions {
  /** Treat a placeholder-only name as a failure rather than advice. */
  strictPlaceholder?: boolean;
}

/**
 * Whether controls have a usable accessible name, read from the browser's own
 * accessibility tree.
 *
 * The interesting failures here are not "no label at all" — a linter catches
 * those. They are the ones where a label is clearly present in the markup and
 * silently does not apply: `for` pointing at an id that does not exist,
 * `aria-labelledby` referencing a removed node, a placeholder standing in for a
 * label. Those look correct in review and are invisible without asking the
 * browser what it computed.
 */
export function labelWiringProbe(
  collected: CollectResult,
  axNodes: AxNode[],
  options: LabelWiringOptions = {},
): Finding[] {
  const { strictPlaceholder = false } = options;
  const byIdx = indexByElement(axNodes);
  const findings: Finding[] = [];

  const idsInDocument = new Set(
    collected.snapshots.map((s) => s.attrs.id).filter((v): v is string => Boolean(v)),
  );

  for (const s of collected.snapshots) {
    if (!s.visible) continue;

    // --- Dangling wiring: reported whether or not a name survived, because a
    // --- broken reference is a bug even when a fallback happens to cover it.
    findings.push(...danglingReferences(s, idsInDocument));

    const ax = byIdx.get(s.idx);

    // Images are named by alt text, and an image with no alt is announced as its
    // filename — worse than useless.
    if (s.tag === "img") {
      const alt = s.attrs.alt;
      if (alt === undefined) {
        findings.push({
          id: makeFindingId("label-wiring", s.selector, "img-no-alt"),
          rule: "label-wiring",
          severity: "serious",
          wcag: ["1.1.1 Non-text Content (A)"],
          selector: s.selector,
          label: describeElement(s),
          facts: {
            computedName: ax?.name ?? "",
            verdict: "image has no alt attribute, so its filename is announced instead",
          },
          fix: {
            summary:
              "Add alt text describing the image's purpose, or alt=\"\" if it is purely decorative.",
            html: `<img ... alt="describe the image, or empty if decorative">`,
          },
          sourceHint: sourceHint(s),
        });
      }
      continue;
    }

    if (!ax) continue;

    const needsName =
      MUST_BE_NAMED.has(ax.role) ||
      (NAMED_BY_TAG.has(s.tag) && s.interactive && s.attrs.type !== "hidden");
    if (!needsName) continue;

    // A submit input is named by its value; a hidden one is not rendered at all.
    if (s.tag === "input" && (s.attrs.type === "hidden" || s.attrs.type === "submit")) continue;

    const name = ax.name.trim();

    if (!name) {
      findings.push(missingName(s, ax));
      continue;
    }

    // A placeholder disappears the moment the user types, so it cannot be the
    // only name. The browser reports it as the name, which is exactly why this
    // needs the name *sources* and not just the name.
    const namedOnlyByPlaceholder = ax.nameSources.some(
      (src) => !src.superseded && src.attribute === "placeholder" && Boolean(src.attributeValue?.value),
    );
    if (namedOnlyByPlaceholder) {
      findings.push({
        id: makeFindingId("label-wiring", s.selector, "placeholder-only"),
        rule: "label-wiring",
        severity: strictPlaceholder ? "serious" : "moderate",
        wcag: ["1.3.1 Info and Relationships (A)", "3.3.2 Labels or Instructions (A)"],
        selector: s.selector,
        label: describeElement(s),
        facts: {
          computedName: name,
          nameFrom: "placeholder",
          verdict: "the placeholder is the only accessible name, and it vanishes on input",
        },
        fix: {
          summary: `Add a <label for="${s.attrs.id ?? "…"}"> (or aria-label) and keep the placeholder as a hint only.`,
          html: s.attrs.id
            ? `<label for="${s.attrs.id}">${name}</label>`
            : `<label for="ID">${name}</label>  <!-- and add id="ID" to the input -->`,
        },
        sourceHint: sourceHint(s),
      });
      continue;
    }

    // SC 2.5.3: a control's visible text must be contained in its accessible name,
    // or voice-control users cannot say what they see.
    //
    // Only the element's *own* text counts as its visible label. Descendant text
    // is frequently not a label at all — a <select>'s text content is the list of
    // its options, and comparing "Netherlands Jordan" against the name "Country"
    // reports a defect on a perfectly correct control.
    const visible = s.ownText.trim();
    if (s.tag !== "select" && visible && visible.length < 60 && !containsLabel(name, visible)) {
      findings.push({
        id: makeFindingId("label-wiring", s.selector, "label-in-name"),
        rule: "label-wiring",
        severity: "moderate",
        wcag: ["2.5.3 Label in Name (A)"],
        selector: s.selector,
        label: describeElement(s),
        facts: {
          visibleText: visible,
          computedName: name,
          verdict: "accessible name does not contain the visible label",
        },
        fix: {
          summary: `Make the accessible name start with the visible text "${visible}" (voice users say what they see).`,
          html: `aria-label="${visible}${name.toLowerCase().includes(visible.toLowerCase()) ? "" : ` ${name}`}"`,
        },
        sourceHint: sourceHint(s),
      });
    }
  }

  return findings;
}

function containsLabel(accessibleName: string, visible: string): boolean {
  const norm = (v: string) =>
    v.toLowerCase().replace(/[\s ]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  return norm(accessibleName).includes(norm(visible));
}

function missingName(s: ElementSnapshot, ax: AxNode): Finding {
  const attempted = attemptedButEmpty(ax);
  const isIconButton = !s.ownText && !s.text;

  const facts: Record<string, string | number | boolean> = {
    role: ax.role,
    computedName: "",
    verdict: "screen readers announce this control with no name",
  };
  if (attempted.length) facts.emptyNameSources = attempted.join(", ");

  let summary: string;
  let html: string | undefined;

  if (s.attrs.ariaLabelledby) {
    summary = `aria-labelledby="${s.attrs.ariaLabelledby}" resolves to nothing — point it at an element that exists and has text.`;
  } else if (s.tag === "input" && s.attrs.id) {
    summary = `Add <label for="${s.attrs.id}">, or aria-label, to name this control.`;
    html = `<label for="${s.attrs.id}">Describe the field</label>`;
  } else if (isIconButton) {
    summary = "Icon-only control: add aria-label describing the action, not the icon.";
    html = `<${s.tag} aria-label="Describe the action">…</${s.tag}>`;
  } else {
    summary = "Give this control an accessible name via visible text, aria-label, or aria-labelledby.";
  }

  const severity: Severity = "critical";

  return {
    id: makeFindingId("label-wiring", s.selector, "no-name"),
    rule: "label-wiring",
    severity,
    wcag: ["4.1.2 Name, Role, Value (A)"],
    selector: s.selector,
    label: describeElement(s),
    facts,
    fix: { summary, html },
    sourceHint: sourceHint(s),
  };
}

/**
 * References that point at nothing.
 *
 * These are the silent ones: the markup reads as correctly labelled, review
 * passes, and the association simply does not exist at runtime.
 */
function danglingReferences(s: ElementSnapshot, idsInDocument: Set<string>): Finding[] {
  const out: Finding[] = [];

  if (s.tag === "label" && s.attrs.htmlFor && !idsInDocument.has(s.attrs.htmlFor)) {
    out.push({
      id: makeFindingId("label-wiring", s.selector, "dangling-for"),
      rule: "label-wiring",
      severity: "serious",
      wcag: ["1.3.1 Info and Relationships (A)", "4.1.2 Name, Role, Value (A)"],
      selector: s.selector,
      label: describeElement(s),
      facts: {
        for: s.attrs.htmlFor,
        verdict: `no element in the document has id="${s.attrs.htmlFor}", so this label names nothing`,
      },
      fix: {
        summary: `Point for="${s.attrs.htmlFor}" at the control's real id, or wrap the control in the <label>.`,
        html: `<label>${s.ownText || "Label"} <input …></label>`,
      },
      sourceHint: sourceHint(s),
    });
  }

  for (const [attr, value] of [
    ["aria-labelledby", s.attrs.ariaLabelledby],
    ["aria-describedby", s.attrs.ariaDescribedby],
  ] as const) {
    if (!value) continue;
    const missing = value.split(/\s+/).filter((id) => id && !idsInDocument.has(id));
    if (missing.length === 0) continue;
    out.push({
      id: makeFindingId("label-wiring", s.selector, `dangling-${attr}`),
      rule: "label-wiring",
      severity: attr === "aria-labelledby" ? "serious" : "moderate",
      wcag: ["4.1.2 Name, Role, Value (A)"],
      selector: s.selector,
      label: describeElement(s),
      facts: {
        [attr]: value,
        missingIds: missing.join(", "),
        verdict: `${attr} references ${missing.length > 1 ? "ids that do not exist" : "an id that does not exist"}`,
      },
      fix: {
        summary: `Remove or correct ${attr}="${value}" — ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not in the document.`,
      },
      sourceHint: sourceHint(s),
    });
  }

  return out;
}
