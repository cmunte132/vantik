/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@vantikhq/eslint-config/server.js'],
  // No rule in this config needs type information, so the parser gets no
  // `project`. With `project`, the parser makes a full TypeScript program of
  // the server, and lint uses approximately 0.9 GB more memory for the same
  // result (ENG-333). If you add a rule that needs type information, set
  // `parserOptions.project` again.
};
