---
name: a11y-render-gate
description: Check rendered UI for accessibility defects before calling UI work done. Use whenever you have written or changed anything that renders — a component, a page, a stylesheet, a design token, a theme — and before reporting that UI work is complete. Also use when asked about contrast, focus rings, tap targets, labels, keyboard access, WCAG, or accessibility generally.
---

# Accessibility gate

You cannot see what you wrote. This checks it by rendering it.

## When to run it

Run `a11y_check` after writing or changing anything that renders, and **before**
saying the work is done. Colour values, a CSS reset, a new component, a theme
switch, a layout change — all of it.

## How to run it

Pass exactly one source:

| Situation | Call |
|---|---|
| A dev server is running | `a11y_check({ url: "http://localhost:5173/checkout" })` |
| You just wrote a self-contained snippet | `a11y_check({ html: "<button …>", css: "…" })` |
| The project has Storybook | `a11y_check({ story: "ui-button--secondary" })` |
| No server running, but the project uses Vite | `a11y_check({ component: "src/ui/Button.tsx", export: "Button" })` |
| That component needs a provider | add `wrapper: "./a11y.wrapper.tsx"` |
| The UI is behind an interaction | `a11y_check({ url: "…", actions: [{ click: ".open-cart" }, { wait: 300 }] })` |

If a source will not load, call `a11y_status` to see what is actually reachable
rather than guessing at ports.

## Reading the result

Every finding carries measured values and a fix. Apply the fix as given — the
numbers have already been computed against the real rendering, so you do not need
to estimate whether a colour will pass.

```
serious contrast
  p "Secondary text"  p.muted
    #8a8a8a on #ffffff = 3.45:1, need 4.5 (14px)
    → Set color to #767676 (4.54:1 against #ffffff).
```

Re-run after fixing. The second run reports movement (`2 fixed · 1 still failing ·
0 new`) rather than restating everything, so iterating is cheap.

Use `a11y_explain({ findingId })` when you need the full detail for one finding
instead of re-running the whole check.

## What the findings mean

- **contrast** — the ratio of the text as it actually composited, including alpha,
  ancestor backgrounds, and gradients. Not what the CSS says; what rendered.
- **focus-visible** — measured by screenshotting the element, focusing it,
  screenshotting again, and diffing. `0 pixels change when focused` means the
  focus indicator does not exist. This is almost always a reset containing
  `outline: none` with no `:focus-visible` replacement.
- **target-size** — WCAG 2.2 SC 2.5.8. The spacing and inline exceptions are
  already applied, so a reported finding is a real one.
- **label-wiring** — the accessible name as the browser computed it. A `for`
  attribute pointing at a missing id, or an `aria-labelledby` resolving to
  nothing, looks correct in the markup and names nothing at runtime.
- **keyboard-reach** — controls a mouse can use and Tab cannot, usually
  `<div onClick>`.

## Rules

- **Fix the finding, do not silence it.** `a11y_accept_baseline` exists for
  pre-existing debt the user has explicitly decided not to address. Never use it
  on a defect you just introduced, and never without asking.
- **Do not argue with a measurement.** The ratio, the pixel count, and the
  computed name are facts about the rendering. If one looks wrong, re-run and
  look at the annotated screenshot.
- **`advice` findings are not failures.** They mark things WCAG explicitly
  exempts, such as the contrast of a disabled control. Do not "fix" them unless
  asked.
- **If the gate blocks your turn**, the stderr report lists what to fix. Fix it
  and re-run; do not try to work around the hook.
