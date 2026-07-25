/**
 * Every sibling package carries one of these; agent-core shipped without it, so
 * `pnpm lint` here failed to find a config at all and the package was never
 * linted or prettier-formatted.
 *
 * The server preset is the right base: this is plain Node and TypeScript, with
 * no JSX and no Next, and unlike the internal preset it does not pull in
 * `eslint:recommended`'s `no-undef`, which cannot see Node or jest globals
 * without an `env` this package would then have to maintain.
 */
/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@vantikhq/eslint-config/server.js'],
  parser: '@typescript-eslint/parser',
};
