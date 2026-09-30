/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: [
    '@vantikhq/eslint-config/internal.js',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    'no-redeclare': 'off',
    // TypeScript checks props and DOM attributes; eslint-config-next turned
    // these two off for the same reason.
    'react/prop-types': 'off',
    'react/no-unknown-property': 'off',
  },
};
