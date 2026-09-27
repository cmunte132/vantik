/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@vantikhq/eslint-config/internal.js'],
  parser: '@typescript-eslint/parser',
  rules: {
    'no-redeclare': 'off',
  },
  // The internal preset turns on `no-undef`, which cannot see jest's globals
  // without being told the specs run under jest.
  overrides: [{ files: ['**/*.spec.ts'], env: { jest: true } }],
};
