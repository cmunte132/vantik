/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@vantikhq/eslint-config/server.js'],
  parserOptions: {
    project: true,
  },
};
