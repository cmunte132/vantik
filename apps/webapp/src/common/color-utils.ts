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

// getTailwindColor and getTeamColor used to be copied out here as well. Nothing
// imported them, and a second copy of a colour rule is how the sidebar came to
// hold two palettes at once. Import them from '@vantikhq/ui/lib/color-utils'.
