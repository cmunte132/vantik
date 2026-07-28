/**
 * Generates an OKLCH color string with fixed lightness, chroma, and a random hue.
 * @returns {string} - The generated OKLCH color string.
 */
export function generateOklchColor(): string {
  // Generate a random number between 30 and 360 for the hue
  const hue = Math.floor(Math.random() * (360 - 30 + 1)) + 30;

  // Fixed lightness and chroma values
  const lightness = 66;
  const chroma = 0.1835;

  // Construct the OKLCH color string
  const oklchColor = `oklch(${lightness}% ${chroma} ${hue})`;

  return oklchColor;
}

export function getTailwindColor(name: string): string {
  if (!name) {
    return `var(--custom-color-1)`;
  }

  // Generate a hash value for the input name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Ensure hash value is within the range of colors array
  const index = Math.abs(hash) % 12;

  return `var(--custom-color-${index + 1})`;
}

/**
 * The colour of a team.
 *
 * A team draws from the same twelve colours as a person, a product and a
 * module. It used to have three pastels of its own, which put two palettes in
 * one sidebar: a team came out pale and the module directly under it came out
 * saturated, from the same rounded square in the same list.
 *
 * Three colours could not tell a workspace's teams apart anyway — the fourth
 * team repeats the first.
 *
 * Kept as a function of its own because the call sites name it, and because a
 * team may one day pick its colour the way a product already can.
 */
export function getTeamColor(name: string): string {
  return getTailwindColor(name);
}
