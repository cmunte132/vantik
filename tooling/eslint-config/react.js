/** Copyright (c) 2024, Vantik, all rights reserved. **/

module.exports = {
  extends: [
    "prettier",
    "plugin:prettier/recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
    "turbo",
  ],
  plugins: [
    "@typescript-eslint",
    "prettier",
    "unused-imports",
    "notice",
    "import",
  ],
  env: { browser: true, node: true, es2022: true },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  rules: {
    // TypeScript checks props and DOM attributes; eslint-config-next turned
    // these two off for the same reason.
    "react/prop-types": "off",
    "react/no-unknown-property": "off",
    curly: "warn",
    // `x == null` is the idiom for null-or-undefined; everything else is strict.
    eqeqeq: ["error", "always", { null: "ignore" }],
    "prettier/prettier": "warn",
    "unused-imports/no-unused-imports": "warn",
    "no-else-return": "warn",
    "no-lonely-if": "warn",
    "no-inner-declarations": "off",
    "no-unused-vars": "off",
    "no-useless-computed-key": "warn",
    "no-useless-return": "warn",
    "no-var": "warn",
    "object-shorthand": ["warn", "always"],
    "prefer-arrow-callback": "warn",
    "prefer-const": "warn",
    "prefer-destructuring": ["warn", { AssignmentExpression: { array: true } }],
    "prefer-object-spread": "warn",
    "prefer-template": "warn",
    "spaced-comment": ["warn", "always", { markers: ["/"] }],
    yoda: "warn",
    "import/order": [
      "warn",
      {
        "newlines-between": "always",
        groups: [
          "type",
          "builtin",
          "external",
          "internal",
          ["parent", "sibling"],
          "index",
        ],
        pathGroupsExcludedImportTypes: ["builtin"],
        pathGroups: [
          {
            pattern: "+(modules){/**,}",
            group: "internal",
            position: "after",
          },
          {
            pattern: "+(common|wrappers|layouts){/**,}",
            group: "internal",
            position: "after",
          },
          {
            pattern: "+(icons|components|hooks){/**,}",
            group: "internal",
            position: "after",
          },
          {
            pattern: "+(services){/**,}",
            group: "internal",
            position: "after",
          },
          {
            pattern: "+(store){/**,}",
            group: "internal",
            position: "after",
          },
        ],
        alphabetize: {
          order:
            "asc" /* sort in ascending order. Options: ['ignore', 'asc', 'desc'] */,
          caseInsensitive: true /* ignore case. Options: [true, false] */,
        },
      },
    ],
    "@typescript-eslint/array-type": ["warn", { default: "array-simple" }],
    "@typescript-eslint/ban-ts-comment": [
      "warn",
      {
        "ts-expect-error": "allow-with-description",
      },
    ],
    "@typescript-eslint/ban-types": "warn",
    "@typescript-eslint/consistent-indexed-object-style": ["warn", "record"],
    "@typescript-eslint/consistent-type-definitions": ["warn", "interface"],
    "@typescript-eslint/no-unused-vars": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
  },
  parser: "@typescript-eslint/parser",
  settings: {
    react: { version: "detect" },
  },
  ignorePatterns: [
    "src/@@generated/**/*.tsx",
    "src/@@generated/**/*.ts",
    "**.js",
  ],
  overrides: [
    {
      files: ["scripts/**/*"],
      rules: {
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
};
