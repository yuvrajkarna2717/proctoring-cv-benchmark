import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist", "coverage", "reports", "public/models", "public/vendor"]),
  {
    files: ["**/*.{js,jsx,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "zod",
              message: 'Import { z } from "src/utils/zod.js" (jitless, CSP-safe) instead.',
            },
          ],
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "all", ignoreRestSiblings: true },
      ],
      "no-console": ["warn", { allow: ["info", "warn", "error"] }],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
    },
  },
  {
    files: ["src/utils/zod.js"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/**/*.jsx"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    files: ["src/workers/**/*.js"],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.{js,mjs}", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
]);
