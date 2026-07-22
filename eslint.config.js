import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import jsxA11y from "eslint-plugin-jsx-a11y"
import react from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"

export default defineConfig([
  globalIgnores([
    ".npm-cache/**",
    ".vercel/**",
    "contracts/cache/**",
    "contracts/lib/**",
    "contracts/out/**",
    "dist/**",
    "dist-e2e/**",
    "node_modules/**",
    "public/**",
    "reference/**",
  ]),
  {
    files: ["src/**/*.{js,jsx}"],
    extends: [
      js.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat["jsx-runtime"],
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/prop-types": "off",
    },
  },
  {
    files: ["src/**/*.test.{js,jsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "scripts/**/*.{js,mjs}",
      "tools/**/*.{js,mjs}",
      "e2e/**/*.js",
      "playwright.config.js",
      "vite.config*.{js,mjs}",
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      parserOptions: {
        sourceType: "module",
      },
    },
  },
  {
    files: ["e2e/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["tools/release-console/app.mjs", "tools/release-console/core.mjs"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
])
