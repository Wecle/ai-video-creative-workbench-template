import { defineConfig } from "vitest/config";

// tsconfig keeps `jsx: preserve` for Next; tests that import components need it compiled.
export default defineConfig({ esbuild: { jsx: "automatic" } });
