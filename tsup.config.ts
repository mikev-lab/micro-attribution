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
