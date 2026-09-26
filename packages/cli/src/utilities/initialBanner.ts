import { chalkGrey, logo } from './cliOutput';
import { getVersion } from './getVersion';
import { logger } from './logger';

export async function printInitialBanner() {
  const cliVersion = getVersion();
  const text = `\n${logo()} ${chalkGrey(`(${cliVersion})`)}\n`;

  logger.info(text);
}
