import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import next from "@next/eslint-plugin-next";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("./apps/web/", import.meta.url));

const agentCorePureFiles = [
  "packages/agent-core/src/pure.ts",
  "packages/agent-core/src/policy/**/*.ts",
  "packages/agent-core/src/loop/**/*.ts",
  "packages/agent-core/src/context/**/*.ts",
  "packages/agent-core/src/router/**/*.ts",
  "packages/agent-core/src/profiles/types.ts",
  "packages/agent-core/src/profiles/general.ts",
  "packages/agent-core/src/tools/names.ts",
];

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
            {
              name: "ai",
              message:
                "Direct 'ai' imports are not allowed in web frontend. Use API client or backend routes.",
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
            "@creative/storage",
            "@creative/storage/*",
            "@aws-sdk/*",
            "ioredis",
            "@creative/agent-core",
            "@creative/agent-core/*",
            "@ai-sdk/*",
          ],
        },
      ],
    },
  },
  {
    // Workflow code runs in Temporal's deterministic sandbox: no IO, no clocks, no Node APIs.
    // Allow only @temporalio/workflow, @creative/agent-core/pure and relative imports (type imports are free).
    files: ["packages/workflows/src/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!@temporalio/workflow$|@creative/agent-core/pure$|\\.{1,2}(/|$))",
              allowTypeImports: true,
              message:
                "Workflow code may only import @temporalio/workflow, @creative/agent-core/pure and relative modules. Put IO in activities (services/agent-runner).",
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
    // Agent-core pure code is deterministic and free of external dependencies.
    // Allow only relative imports (type imports are free).
    files: agentCorePureFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.{1,2}(/|$))",
              allowTypeImports: true,
              message:
                "Agent-core pure code may only use relative imports and zero external runtime dependencies.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "process", "require", "XMLHttpRequest", "WebSocket"].map(
          (name) => ({
            name,
            message: "Not available in deterministic agent-core pure modules.",
          }),
        ),
      ],
    },
  },
  {
    // Restrict AI SDK and node:* imports to runtime modules in agent-core.
    files: ["packages/agent-core/src/**/*.ts"],
    ignores: [
      "packages/agent-core/src/runtime/**",
      "packages/agent-core/src/skills/runtime/**",
      "packages/agent-core/src/runtime.ts",
      ...agentCorePureFiles,
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(ai|@ai-sdk/.*|node:.*|assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|fs/promises|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|wasi|worker_threads|zlib)(/.*)?$",
              allowTypeImports: true,
              message:
                "AI SDK and Node APIs are only allowed in runtime modules (@creative/agent-core/runtime).",
            },
          ],
        },
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
