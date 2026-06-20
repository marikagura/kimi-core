import tseslint from "typescript-eslint";

// Curated, not the full recommended firehose — this is the first lint pass over a
// mature codebase, so it enables only high-value rules that earn their keep, kept
// green-or-warn so it never blocks on day one.
//
// The load-bearing one is no-floating-promises: an un-awaited promise in the
// daemon / intel paths silently drops a DB write or reorders work, and tsc cannot
// see it. no-explicit-any is the diagnosis's concern, kept at "warn" because a
// handful of legitimate anys remain (raw-SQL $queryRaw rows, AbortSignal feature
// detection); flip it to "error" once those are annotated.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/*.config.*",
      "packages/db/prisma/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.base], // parser + plugin only; rules are chosen below
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Test fixtures intentionally throw odd shapes, float promises, and use `any`.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
