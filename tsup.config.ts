import { defineConfig } from "tsup";

// One self-contained file: the published CLI has no runtime dependencies to install.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  bundle: true,
  noExternal: [/.*/],
  clean: true,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __lbRequire } from 'node:module'; const require = __lbRequire(import.meta.url);" },
});
