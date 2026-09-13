# a11y-gate

**An accessibility gate inside the agent loop.**

An agent writing UI has no perception. It emits `text-gray-400` on white, a
`<div onClick>`, an 18px icon button, and a CSS reset containing `outline: none`
with no replacement. Then it says "done." It cannot see the result, so it cannot
know. The human reviewing it usually can't either — nobody eyeballs a contrast
ratio.

`a11y-gate` renders the UI the agent just wrote, measures it, and hands back
**computed facts with fixes attached** — then blocks the turn until they're fixed.

```
a11y-gate FAIL  http://localhost:5173/checkout
desktop 1440x900, light · 47 elements · 1.2s

critical focus-visible  ×4
  button "Continue"  button.btn-primary
    0 pixels change when focused — no indicator renders
    → outline is set to none with no replacement — add a :focus-visible ring.
       :focus-visible {
         outline: 2px solid #1a5fd0;
         outline-offset: 2px;
       }
    same fix applies to: input#email, input#card, button "Back"

serious contrast
  p "Secondary text"  p.muted
    #8a8a8a on #ffffff = 3.45:1, need 4.5 (14px)
    → Set color to #767676 (4.54:1 against #ffffff).
       color: #767676;
```

---

## Why this is not another linter

| Tool | What it does | Why it doesn't close this loop |
|---|---|---|
| `eslint-plugin-jsx-a11y` | Static analysis | Can't know `--color-muted` became 3.1:1 after a token change |
| axe-core | Rule engine on a live DOM | Returns rule names, not values. Gives up on gradients. **Ships no focus-visibility check at all.** |
| Lighthouse | Page score | Wrong granularity, slow, a report for a human |
| CI a11y jobs | Post-hoc | Runs after the agent stopped, for a different person, at 10× the fix cost |

All of them are built so a **human reads a report afterwards**. None make the
**agent check itself and fix it in the same turn**.

Two things make this different:

**1. Findings are shaped like fixes.**

```
axe:        color-contrast: Elements must have sufficient color contrast (serious)
            <button class="btn-secondary">Continue</button>

a11y-gate:  #8a8a8a on #ffffff = 3.45:1, need 4.5:1 (14px, normal)
            → Set color to #767676 (4.54:1 against #ffffff)
```

The second one an agent acts on in one step. The first requires a guess.

**2. Focus visibility is measured, not inferred.**

Screenshot the element at rest → focus it → screenshot again → diff the crops.
Zero changed pixels means the focus indicator **does not exist on screen**. This
isn't statically expressible, axe doesn't attempt it, and it's epidemic in
generated UI because every CSS reset kills the default outline.

---

## Install

```bash
npm install -D a11y-gate
npx playwright install chromium
npx a11y-gate init
```

### As a Claude Code plugin

Bundles the MCP server, the blocking Stop hook, and the skill in one unit:

```bash
claude --plugin-dir /path/to/a11y-gate
```

---

## Use

```bash
a11y-gate check http://localhost:5173/checkout   # a running app
a11y-gate check ./component.html                 # a standalone file
a11y-gate check --story ui-button--secondary     # a Storybook story
a11y-gate doctor                                 # what can it currently reach?
```

Exit codes: `0` pass, `1` findings at or above your threshold, `2` couldn't check
(so CI can tell "broken" apart from "inaccessible").

### As an MCP tool

| Tool | Purpose |
|---|---|
| `a11y_check` | Render and report. Call before saying UI work is done. |
| `a11y_explain` | Full detail for one finding, without re-running. |
| `a11y_status` | Is the dev server up? What's configured? |
| `a11y_accept_baseline` | Accept pre-existing debt (ask the user first). |

State behind an interaction is reachable:

```js
a11y_check({ url: "/cart", actions: [{ click: ".open-cart" }, { wait: 300 }] })
```

---

## What it checks

| Rule | What's measured | Criteria |
|---|---|---|
| **contrast** | Real composited ratio — alpha, ancestor backgrounds, and gradients sampled from rendered pixels | 1.4.3 / 1.4.6 |
| **focus-visible** | Pixel diff on focus; indicator contrast against adjacent colours | 2.4.7, 1.4.11 |
| **target-size** | Hit-target box, with the spacing and inline exceptions applied | 2.5.8 |
| **label-wiring** | Accessible name as *the browser computed it*, via the a11y tree | 4.1.2, 1.1.1, 2.5.3 |
| **keyboard-reach** | Click handlers Tab can't reach, focus traps, tab order | 2.1.1, 2.1.2, 2.4.3 |
| **state-contrast** | Contrast under `:hover` / `:focus` (opt-in) | 1.4.3 |
| **axe** | 90 structural rules as a breadth backstop (opt-in) | various |

### Where the value is concentrated

- **Broken wiring that looks correct.** `<label for="emial">` names nothing.
  `aria-labelledby` pointing at a removed node names nothing. Both read as
  correct in review. Reading the browser's accessibility tree is the only way to
  see it.
- **Contrast that isn't what the CSS says.** 30%-opacity black text isn't black.
  Text on a gradient has no single background — axe reports "incomplete", this
  samples the pixels and returns a number.
- **The states nobody checks.** A `:hover` colour is chosen by eye and never
  measured, so controls go unreadable exactly while you point at them.

---

## Configuration

`a11y-gate.config.json`. **Its presence is the opt-in** — the Stop hook does
nothing in a project without one, so installing the plugin never changes how an
unrelated repo behaves.

```jsonc
{
  "level": "AA",
  "sources": {
    "baseUrl": "http://localhost:5173",
    "storybookUrl": "http://localhost:6006",
    "routes": ["/", "/checkout"]
  },
  "viewports": [
    { "name": "mobile",  "width": 390,  "height": 844 },
    { "name": "desktop", "width": 1440, "height": 900 }
  ],
  "themes": ["light", "dark"],
  "rules": {
    "state-contrast": { "enabled": true },
    "axe": { "enabled": true }
  },
  "ignore": [".third-party-widget"],
  "failOn": ["critical", "serious"],
  "baseline": ".a11y-gate/baseline.json"
}
```

Checking `dark` is worth the extra pass: contrast defects hide there constantly,
because the light palette is the one anybody looks at.

### Adopting in an existing codebase

The first run on a real app produces a lot. Draw a line and hold it:

```bash
a11y-gate check /
a11y-gate baseline accept --note "pre-existing, tracked in PROJ-482"
```

Only **new** findings fail from now on. Without this step the gate blocks
everything on day one and gets disabled permanently, which is the most common way
tools like this die.

---

## The Stop hook

Five guards run before it is ever willing to block:

```
1. stop_hook_active           → exit 0   never loops
2. A11Y_GATE_DISABLE set      → exit 0   escape hatch
3. no config in the project   → exit 0   opt-in only
4. no UI files changed        → exit 0   git-aware
5. dev server unreachable     → exit 0   never block on infrastructure
                                         the user didn't start
→ otherwise: check, and exit 2 with the findings if it fails
```

That conservatism is deliberate. A gate that blocks for a bad reason once gets
uninstalled, and then it prevents nothing at all.

---

## Design notes

**One collection pass, pure probes.** A single `page.evaluate` captures every
element's geometry, computed styles, background stack, and ancestry. Probes are
pure functions over that data — testable with no browser, and one DOM traversal
per check instead of one per rule.

**Token budget is a design constraint.** A raw axe dump is 5–10k tokens; a check
that expensive gets called once and then avoided, which defeats the point, since
the value is in re-running after a fix. Target is ~1200 tokens: severity ordering,
identical fixes collapsed, capped per rule, full JSON written to
`.a11y-gate/last-run.json` as the escape valve. Re-runs report movement
(`2 fixed · 1 still failing · 0 new`) rather than restating everything.

**False positives are worse than misses.** For a gate, a wrong finding costs more
than a missed one, because it burns the tool's credibility. The WCAG 2.2 spacing
and inline exceptions are implemented; disabled-control contrast is exempt from
1.4.3 and reported as `advice`, never as a failure; a `box-shadow` focus ring is
recognised as valid. The test suite's most important case is a correct page that
must produce **zero** findings.

---

## Status — v0.1.0

Working and covered by tests: the CLI, the MCP server, the blocking Stop hook,
the Claude Code plugin, and all seven rules. Sources `url`, `html`, and
`storybook` are implemented. 54 tests pass, fixture-driven.

Not built yet:

- **`component` source** — rendering a `.tsx`/`.vue` file in isolation by reusing
  the project's own Vite config. Currently throws a clear not-implemented error
  pointing at `url` or `storybook`. This is the highest-risk adapter and it is
  absent rather than half-working on purpose.
- **Source mapping** — findings carry the offending element's classes, but not a
  `file:line`.
- **Not yet published to npm.** Install from source for now.

Interfaces may change before 1.0.

## Limitations

Not a full WCAG audit, and no substitute for testing with real assistive
technology. It checks what a browser can compute. It does not evaluate whether
alt text is *good*, only whether it exists; it does not cover cognitive
accessibility; and screen-reader behaviour differs from the accessibility tree in
ways this cannot see.

Automated checks catch roughly a third of WCAG issues. This aims to make that
third free and immediate, not to pretend it is all of them.

---

## Development

```bash
npm install && npx playwright install chromium
npm test          # fixture-driven, ~5s
npm run build
```

Fixtures in `fixtures/broken/` declare their expected findings in a header
comment; `fixtures/clean/` must yield zero.

MIT.
