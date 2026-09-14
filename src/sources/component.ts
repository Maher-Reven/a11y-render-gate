import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GateError } from "../core/errors.js";

/**
 * Render one component in isolation, using the project's own build.
 *
 * The reason tools like this usually fail is that they try to reconstruct the
 * project's build themselves — resolving aliases, finding the PostCSS config,
 * guessing how Tailwind is wired — and are wrong in a different way for every
 * repository. This does none of that. It loads the project's *own* Vite, from
 * the project's own node_modules, pointed at the project's own config file, so
 * aliases, plugins, CSS pipeline and environment all come along for free and
 * stay correct as the project changes them.
 *
 * What it deliberately does not do is guess at providers. A component that needs
 * a router, a theme or a query client is not something we can infer, so the
 * wrapper is declared in config rather than detected. Guessing there produces
 * confident nonsense.
 */

export const MOUNT_ID = "a11y-render-gate-root";
const VIRTUAL_ENTRY = "virtual:a11y-render-gate-entry";
const RESOLVED_ENTRY = `\0${VIRTUAL_ENTRY}`;
const HARNESS_PATH = "/__a11y-render-gate__";

export type Framework = "react" | "vue" | "svelte" | "vanilla";

export interface ComponentHarnessOptions {
  /** Project root — where vite.config and package.json live. */
  root: string;
  /** Path to the component module, relative to root or absolute. */
  component: string;
  /** Named export to mount. Defaults to the default export. */
  exportName?: string;
  /** Props to mount with. */
  props?: Record<string, unknown>;
  /** Module exporting a provider wrapper, declared not detected. */
  wrapper?: string;
  /** Explicit vite config path; auto-detected when omitted. */
  viteConfig?: string;
  /** Override framework detection. */
  framework?: Framework;
}

export interface ComponentHarness {
  url: string;
  close(): Promise<void>;
}

const VITE_CONFIG_NAMES = [
  "vite.config.ts", "vite.config.js", "vite.config.mjs",
  "vite.config.mts", "vite.config.cts", "vite.config.cjs",
];

/**
 * Start a Vite dev server that serves exactly one component, and return its URL.
 *
 * The caller navigates to the URL like any other page source, which is what lets
 * every probe work unchanged against an isolated component.
 */
export async function startComponentHarness(
  options: ComponentHarnessOptions,
): Promise<ComponentHarness> {
  const root = resolve(options.root);

  const componentPath = isAbsolute(options.component)
    ? options.component
    : resolve(root, options.component);
  if (!existsSync(componentPath)) {
    throw new GateError(
      `Component not found: ${options.component}`,
      `Path is resolved relative to ${root}. Check the path, or pass an absolute one.`,
    );
  }
  if (!isInside(root, componentPath)) {
    throw new GateError(
      `Component ${options.component} is outside the project root (${root}).`,
      "Vite can only serve files under its root. Move the component, or set component.root.",
    );
  }

  const vite = await loadProjectVite(root);
  const framework = options.framework ?? detectFramework(root);
  const configFile = resolveViteConfig(root, options.viteConfig);

  const entryCode = generateEntry({
    framework,
    componentUrl: toRootUrl(root, componentPath),
    exportName: options.exportName,
    props: options.props ?? {},
    wrapperUrl: options.wrapper
      ? toRootUrl(root, resolve(root, options.wrapper))
      : undefined,
  });

  const harnessPlugin = {
    name: "a11y-render-gate:harness",
    // `enforce: pre` so our virtual id is resolved before any project plugin
    // with a catch-all resolver gets a chance to claim it.
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id === VIRTUAL_ENTRY) return RESOLVED_ENTRY;
      return null;
    },
    load(id: string) {
      if (id === RESOLVED_ENTRY) return entryCode;
      return null;
    },
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = (req.url ?? "").split("?")[0];
        if (url !== HARNESS_PATH && url !== `${HARNESS_PATH}/`) return next();
        try {
          const html = await server.transformIndexHtml(req.url, harnessHtml());
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };

  let server: any;
  try {
    server = await vite.createServer({
      root,
      // `false` means "do not look for one"; undefined means "auto-detect".
      // Passing the project's own config is the entire point of this adapter.
      configFile: configFile ?? false,
      logLevel: "silent",
      // A component harness has no use for HMR, and the websocket it opens can
      // keep the process alive after we are done with it.
      server: { port: 0, strictPort: false, hmr: false, host: "127.0.0.1" },
      optimizeDeps: { noDiscovery: false },
      plugins: [harnessPlugin],
    });
    await server.listen();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GateError(
      `Could not start Vite for the component harness: ${message.split("\n")[0]}`,
      configFile
        ? `Check that ${relative(root, configFile)} loads correctly (try running your own dev server).`
        : "No vite config was found. Set component.viteConfig, or use `url`/`storybook` instead.",
    );
  }

  const urls = server.resolvedUrls?.local ?? [];
  const base: string = urls[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
  const url = new URL(HARNESS_PATH.replace(/^\//, ""), base).toString();

  return {
    url,
    close: async () => {
      await server.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Project introspection
// ---------------------------------------------------------------------------

/**
 * Load Vite from the project, not from our own dependencies.
 *
 * Using the project's copy means its plugins and config run against the version
 * they were written for. Bundling our own Vite would produce a second, subtly
 * different build of the same code and fail in ways nobody could debug.
 */
async function loadProjectVite(root: string): Promise<any> {
  const require = createRequire(join(root, "noop.js"));
  let entry: string;
  try {
    entry = require.resolve("vite");
  } catch {
    throw new GateError(
      `Vite is not installed in ${root}, so a component cannot be rendered in isolation.`,
      "Install vite in the project, or use `url` against your dev server or `storybook` with a story id.",
    );
  }
  try {
    return await import(pathToFileURL(entry).href);
  } catch (err) {
    throw new GateError(
      `Failed to load the project's Vite: ${err instanceof Error ? err.message : String(err)}`,
      "Use `url` or `storybook` instead.",
    );
  }
}

export function resolveViteConfig(root: string, explicit?: string): string | null {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(root, explicit);
    if (!existsSync(path)) {
      throw new GateError(
        `vite config not found: ${explicit}`,
        `Resolved to ${path}. Check component.viteConfig.`,
      );
    }
    return path;
  }
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Which framework to mount with, from what the project actually depends on.
 *
 * Deliberately reads package.json rather than the component's own source: a
 * `.tsx` file says nothing about whether it is React or Preact or Solid, and
 * guessing from file extensions is how you end up mounting the wrong runtime.
 */
export function detectFramework(root: string): Framework {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return "vanilla";

  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return "vanilla";
  }

  if (deps["react-dom"] || deps.react) return "react";
  if (deps.vue) return "vue";
  if (deps.svelte) return "svelte";
  return "vanilla";
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Vite serves project files at root-relative URLs; convert an fs path to one. */
function toRootUrl(root: string, absolutePath: string): string {
  return `/${relative(root, absolutePath).split("\\").join("/")}`;
}

// ---------------------------------------------------------------------------
// Entry generation
// ---------------------------------------------------------------------------

interface EntryArgs {
  framework: Framework;
  componentUrl: string;
  exportName?: string;
  props: Record<string, unknown>;
  wrapperUrl?: string;
}

export function generateEntry(args: EntryArgs): string {
  const { framework, componentUrl, exportName, props, wrapperUrl } = args;
  const propsJson = JSON.stringify(props);
  const pick = exportName
    ? `Mod[${JSON.stringify(exportName)}]`
    : "Mod.default ?? Mod[Object.keys(Mod)[0]]";

  // Anything thrown while mounting has to reach the harness, because a component
  // that fails to render would otherwise present as an empty page with no
  // findings — a false pass, which is the worst outcome this tool can produce.
  const preamble = `
window.__a11yErrors = [];
const record = (e) => {
  const msg = e && e.message ? e.message : String(e);
  if (!window.__a11yErrors.includes(msg)) window.__a11yErrors.push(msg);
};
window.addEventListener("error", (e) => record(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => record(e.reason));
const mountEl = document.getElementById(${JSON.stringify(MOUNT_ID)});
const assertComponent = (C) => {
  if (!C) {
    throw new Error(
      ${JSON.stringify(
        exportName
          ? `The module has no export named "${exportName}".`
          : "The module has no default export to mount.",
      )}
    );
  }
  return C;
};
`.trim();

  const wrapperImport = wrapperUrl
    ? `import * as WrapMod from ${JSON.stringify(wrapperUrl)};\nconst Wrapper = WrapMod.default ?? WrapMod.Wrapper;`
    : "const Wrapper = null;";

  switch (framework) {
    case "react":
      return `
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as Mod from ${JSON.stringify(componentUrl)};
${wrapperImport}
${preamble}
try {
  const Component = assertComponent(${pick});
  let node = React.createElement(Component, ${propsJson});
  if (Wrapper) node = React.createElement(Wrapper, null, node);
  createRoot(mountEl).render(node);
} catch (err) { record(err); }
`.trim();

    case "vue":
      return `
import { createApp, h } from "vue";
import * as Mod from ${JSON.stringify(componentUrl)};
${wrapperImport}
${preamble}
try {
  const Component = assertComponent(${pick});
  const render = Wrapper
    ? () => h(Wrapper, null, { default: () => h(Component, ${propsJson}) })
    : () => h(Component, ${propsJson});
  createApp({ render }).mount(mountEl);
} catch (err) { record(err); }
`.trim();

    case "svelte":
      return `
import * as Mod from ${JSON.stringify(componentUrl)};
${preamble}
try {
  const Component = assertComponent(${pick});
  // Svelte 5 exposes \`mount\`; Svelte 4 components are constructed directly.
  let mounted = false;
  try {
    const svelte = await import("svelte");
    if (typeof svelte.mount === "function") {
      svelte.mount(Component, { target: mountEl, props: ${propsJson} });
      mounted = true;
    }
  } catch {}
  if (!mounted) new Component({ target: mountEl, props: ${propsJson} });
} catch (err) { record(err); }
`.trim();

    case "vanilla":
      return `
import * as Mod from ${JSON.stringify(componentUrl)};
${preamble}
try {
  const factory = assertComponent(${pick});
  // Accept the three shapes plain components take: render into a container,
  // return a node, or return a markup string.
  const out = factory.length >= 1 ? factory(mountEl, ${propsJson}) : factory(${propsJson});
  if (out instanceof Node) mountEl.appendChild(out);
  else if (typeof out === "string") mountEl.innerHTML = out;
} catch (err) { record(err); }
`.trim();
  }
}

function harnessHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>a11y-render-gate component harness</title>
  </head>
  <body>
    <div id="${MOUNT_ID}"></div>
    <script type="module" src="/@id/__x00__${VIRTUAL_ENTRY}"></script>
  </body>
</html>`;
}
