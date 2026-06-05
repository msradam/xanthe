import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "playground/**", "**/*.mjs", "**/*.cjs", "eslint.config.js"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // XState's generic types surface through the adapter; `any` is intentional there.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
