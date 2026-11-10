const js = require('@eslint/js');
const globals = require("globals");

module.exports = [
  { ignores: ["**/node_modules/**", "**/app_file/**", "**/build/**", "**/coverage/**", "**/chart.js", "**/scripts/download-binaries.js"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off"
    }
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: { ...globals.jest }
    }
  }
];
