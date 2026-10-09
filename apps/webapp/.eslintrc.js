module.exports = {
  root: true,
  extends: ['@vantikhq/eslint-config/react.js'],
  // No rule in this config needs type information, so the parser gets no
  // `project`. With `project`, the parser makes a full TypeScript program for
  // each lint run (ENG-333). If you add a rule that needs type information,
  // set `parserOptions.project` again.
};
