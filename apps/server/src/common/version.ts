import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The release this server is, as `pnpm release` wrote it into package.json.
 *
 * Read from the file and not from the environment, so the version cannot drift
 * from the code it describes. The walk up is because the source runs from
 * src/common and the build from dist/src/common, and the image keeps
 * apps/server/package.json beside dist.
 */
function readVersion(): string {
  let directory = __dirname;

  while (directory !== dirname(directory)) {
    const candidate = join(directory, 'package.json');

    if (existsSync(candidate)) {
      const { name, version } = JSON.parse(readFileSync(candidate, 'utf8'));

      if (name === 'server' && version) {
        return version;
      }
    }
    directory = dirname(directory);
  }

  return 'unknown';
}

export const VANTIK_VERSION = readVersion();
