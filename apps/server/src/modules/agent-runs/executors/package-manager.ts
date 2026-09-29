/**
 * Gives the guest the package manager the repository pins.
 *
 * The guest image carries Node and npm, and nothing else: no pnpm, no yarn and
 * no corepack. A repository that installs with pnpm then fails its first setup
 * command with `pnpm: not found`, before the agent has started. This does what
 * corepack would. It reads `packageManager` from the root package.json, and
 * installs exactly that version from the npm registry, which every run can
 * reach already.
 *
 * The value comes from the repository, so it is not trusted. Only a pnpm or
 * yarn name with a plain version gets through, and it goes to npm as one
 * quoted argument, never as shell text. A repository with no such field, or
 * one that names npm, gets nothing and loses nothing.
 *
 * The install goes to the writable workspace, because the guest's root
 * filesystem has about 80MB free. A link in /usr/local/bin puts it on the PATH
 * of every later command, the harness's own shell included.
 */
export const TOOLS_DIR = '/workspace/.tools';

/**
 * A Node script that prints `pnpm@10.34.5`, or nothing. The `+sha…` suffix
 * corepack allows is dropped: npm checks the registry's own integrity for the
 * tarball.
 */
export const READ_PACKAGE_MANAGER = [
  'try {',
  'const value = require("./package.json").packageManager;',
  'const match = /^(pnpm|yarn)@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)(?:\\+.*)?$/.exec(value || "");',
  'if (match) process.stdout.write(match[1] + "@" + match[2]);',
  '} catch {}',
].join(' ');

export const PROVIDE_PACKAGE_MANAGER = [
  'set -e',
  'cd /workspace/repo',
  `pm=$(node -e '${READ_PACKAGE_MANAGER}')`,
  'if [ -z "$pm" ]; then exit 0; fi',
  `npm install --global --prefix ${TOOLS_DIR} --no-audit --no-fund "$pm"`,
  `ln -sf ${TOOLS_DIR}/bin/* /usr/local/bin/`,
  '"${pm%@*}" --version',
].join('\n');
