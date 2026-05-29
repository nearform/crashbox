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
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        process: "readonly",
      },
    },
    rules: {
      curly: ["error", "all"],
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",
      // Allow intentionally-unused args/vars when prefixed with `_` (used by
      // not-yet-implemented stubs and required-but-unused signature params).
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Browser + WebGPU runtime globals for the SDK source and tests. Types come from
    // the `DOM` lib + `@webgpu/types` (tsconfig); these are the runtime value globals
    // ESLint needs to know are defined. Hand-listed deliberately (no `globals` dep).
    files: ["src/**/*.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        // timers / scheduling
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        // window / document / lifecycle
        window: "readonly",
        self: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        addEventListener: "readonly",
        removeEventListener: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        CustomEvent: "readonly",
        // storage
        localStorage: "readonly",
        sessionStorage: "readonly",
        indexedDB: "readonly",
        IDBDatabase: "readonly",
        IDBRequest: "readonly",
        IDBOpenDBRequest: "readonly",
        IDBTransaction: "readonly",
        // platform / observers
        performance: "readonly",
        PerformanceObserver: "readonly",
        ReportingObserver: "readonly",
        crypto: "readonly",
        console: "readonly",
        structuredClone: "readonly",
        WebAssembly: "readonly",
        // WebGPU runtime value globals (enums) — type defs come from @webgpu/types
        GPUBufferUsage: "readonly",
        GPUTextureUsage: "readonly",
        GPUShaderStage: "readonly",
        GPUMapMode: "readonly",
        GPUColorWrite: "readonly",
      },
    },
  },
];
