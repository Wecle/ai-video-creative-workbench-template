import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import next from "@next/eslint-plugin-next";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("./apps/web/", import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    basePath: webRoot,
    files: ["**/*.{ts,tsx}"],
    plugins: { "@next/next": next },
    settings: { next: { rootDir: webRoot } },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
    },
  },
  {
    basePath: webRoot,
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // `paths` matches exactly: better-auth/react and friends stay allowed.
          paths: [
            {
              name: "better-auth",
              message:
                "Import a client subpath (better-auth/react, better-auth/client/plugins, better-auth/cookies); the root entry is server-side.",
            },
          ],
          patterns: [
            "@creative/database",
            "@creative/database/*",
            "drizzle-orm",
            "drizzle-orm/*",
            "postgres",
            "@creative/observability",
            "@temporalio/*",
            "@creative/workflows",
            "@creative/workflows/*",
            "@creative/contracts/internal-auth",
            // Yjs is only reachable through @creative/canvas-doc.
            "yjs",
            "y-protocols",
            "y-protocols/*",
          ],
        },
      ],
    },
  },
  {
    // Workflow code runs in Temporal's deterministic sandbox: no IO, no clocks, no Node APIs.
    // Allow only @temporalio/workflow and relative imports (type imports are free).
    files: ["packages/workflows/src/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!@temporalio/workflow$|\\.{1,2}(/|$))",
              allowTypeImports: true,
              message:
                "Workflow code may only import @temporalio/workflow and relative modules. Put IO in activities (services/agent-runner).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "process", "require", "XMLHttpRequest", "WebSocket"].map(
          (name) => ({
            name,
            message: "Not available in the deterministic workflow sandbox.",
          }),
        ),
      ],
    },
  },
  {
    // Isomorphic packages run in the browser and on the server: no globals that exist in only one.
    files: [
      "packages/node-registry/src/**/*.ts",
      "packages/canvas-doc/src/**/*.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["window", "document", "process", "Buffer", "localStorage"].map(
          (name) => ({
            name,
            message: "Not available in both the browser and Node.",
          }),
        ),
      ],
    },
  },
  {
    files: ["packages/node-registry/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!zod$|\\.{1,2}(/|$))",
              allowTypeImports: true,
              message:
                "node-registry may only import zod and relative modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/canvas-doc/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(zod|yjs|@creative/contracts|@creative/node-registry)$|\\.{1,2}(/|$))",
              allowTypeImports: true,
              message:
                "canvas-doc may only import zod, yjs, @creative/contracts, @creative/node-registry and relative modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
);
