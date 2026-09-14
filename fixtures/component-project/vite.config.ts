import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Deliberately uses an alias and a plugin.
 *
 * The whole claim of the component source is that it inherits the project's real
 * build. If this config's alias and JSX transform did not apply, the fixture
 * would fail to resolve `@styles/theme.css` and fail to compile JSX — so the test
 * proves inheritance rather than asserting it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@styles": resolve(here, "styles"),
      "@ui": resolve(here, "src/ui"),
    },
  },
});
