/**
 * The server suite must fit on a 16 GB machine together with the typecheck,
 * lint, the podman VM and an editor (ENG-333). Three settings keep it small.
 * Each one keeps the same tests.
 *
 * - ts-jest only transpiles (`isolatedModules`). With type checks, each worker
 *   made its own TypeScript program of the server, approximately 1 GB for
 *   each worker. `tsc --noEmit` in `pnpm typecheck` checks the same files,
 *   the spec files too, so a type error still fails a check.
 * - Two workers. Jest starts one worker for each core but one, and the
 *   memory of the suite increases with the number of workers.
 * - The `test` script adds `--max-old-space-size=512` to `NODE_OPTIONS`, and
 *   each worker gets the same limit. Without a limit, V8 lets the heap of a
 *   worker increase to more than 1 GB before it collects the garbage. The
 *   live data of one spec file is less than 250 MB.
 *
 * Start jest through its `node_modules/.bin` shim, not with `node jest.js`.
 * The shim sets `NODE_PATH`. Some controllers import types from `express`,
 * which the server does not declare as a dependency. A transpiled decorator
 * keeps that import, and only `NODE_PATH` lets jest find the package.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  modulePaths: ['<rootDir>'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
    '^.+\\.js$': '@swc/jest',
  },
  transformIgnorePatterns: [],
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  maxWorkers: 2,
};
