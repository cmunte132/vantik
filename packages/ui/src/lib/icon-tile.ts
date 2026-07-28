/**
 * The one size scale for a coloured tile with a glyph inside it.
 *
 * A team, a product and a module all draw the same object: a rounded square in
 * that thing's colour with a small picture in the middle. They sit next to each
 * other in the sidebar, so they have to come off one scale. Three components
 * each choosing their own tile, and each hard-coding the glyph separately from
 * it, is how the sidebar ended up with a 2px margin on one row, 1px on the next
 * and none at all on the third.
 *
 * The tile and its glyph are one entry here, so a caller cannot resize one
 * without the other. That was the actual defect: every call site set the tile
 * with a Tailwind class and none of them could reach the glyph.
 *
 * These are numbers rather than Tailwind classes on purpose. Each package
 * scans its own `./src` for classes, so a class written only in this package is
 * absent from the webapp's stylesheet and the tile silently collapses. A number
 * goes to the icon as its `size` prop and to the tile as a style, and neither
 * can be purged.
 */
export type IconTileSize = 'xs' | 'sm' | 'md' | 'lg';

/** The tile and its glyph, in pixels. Roughly three quarters at every step. */
export const ICON_TILE: Record<IconTileSize, { tile: number; glyph: number }> =
  {
    xs: { tile: 12, glyph: 9 },
    sm: { tile: 14, glyph: 10 },
    md: { tile: 16, glyph: 12 },
    lg: { tile: 20, glyph: 15 },
  };

/** What a caller gets when it asks for no size. */
export const DEFAULT_ICON_TILE: IconTileSize = 'lg';
