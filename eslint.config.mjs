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
            "@creative/job-queue",
            "@creative/observability",
            "@creative/contracts/internal-auth",
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
