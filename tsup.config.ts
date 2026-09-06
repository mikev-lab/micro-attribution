import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts"
    },
    format: ["esm", "cjs", "iife"],
    globalName: "MicroAttribution",
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    treeshake: true,
    splitting: false
  },
  {
    entry: {
      attribution: "src/attribution/index.ts",
      privacy: "src/privacy/index.ts",
      storage: "src/storage/index.ts",
      queue: "src/queue/index.ts",
      edge: "src/edge/index.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    minify: true,
    treeshake: true,
    splitting: false
  }
]);
