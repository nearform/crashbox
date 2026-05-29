import js from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";

export default [
  js.configs.recommended,
  prettierRecommended,
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "./tmp-*",
      // Throwaway research spike harnesses (Node CDP drivers + browser repro pages).
      // Not shipped, not part of the package; exempt from the SDK lint rules.
      "docs/research/spikes/**",
    ],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        TextDecoder: "readonly",
        process: "readonly",
      },
    },
    rules: {
      curly: ["error", "all"],
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",
    },
  },
];
