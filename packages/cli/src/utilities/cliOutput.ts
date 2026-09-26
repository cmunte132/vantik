import chalk from 'chalk';

export const green = '#4FFF54';
export const purple = '#735BF3';

export function chalkGreen(text: string) {
  return chalk.hex(green)(text);
}

export function chalkGrey(text: string) {
  return chalk.hex('#878C99')(text);
}

export function chalkError(text: string) {
  return chalk.hex('#E11D48')(text);
}

export function chalkWarning(text: string) {
  return chalk.yellow(text);
}

export function chalkLink(text: string) {
  return chalk.underline.hex('#D7D9DD')(text);
}

export function logo() {
  return `${chalk.hex(purple).bold('Vantik')}`;
}
