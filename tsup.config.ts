import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "mcp/server": "src/mcp/server.ts",
    "hook/stop-gate": "src/hook/stop-gate.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
