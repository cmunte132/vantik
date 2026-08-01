import { RiBox3Line, RiCodeSSlashLine, RiFocus3Line } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { getTailwindColor } from '@vantikhq/ui/lib/color-utils';
import {
  DEFAULT_ICON_TILE,
  ICON_TILE,
  type IconTileSize,
} from '@vantikhq/ui/lib/icon-tile';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

/**
 * The twelve colours the rest of the app already uses for a person or a team.
 * Reusing them keeps a module the same kind of object on screen as everything
 * else, rather than a new palette nobody recognises.
 */
const COLOURS = Array.from(
  { length: 12 },
  (_, index) => `var(--custom-color-${index + 1})`,
);

/**
 * A short set of pictures. Not an emoji keyboard: a product or a module is
 * picked from a list once and then read a hundred times, and a small set keeps
 * two of them from looking the same.
 */
const GLYPHS = [
  '📦',
  '🧩',
  '⚙️',
  '🖥️',
  '📱',
  '🌐',
  '🔌',
  '🗄️',
  '🔐',
  '📊',
  '✉️',
  '🤖',
  '🎨',
  '📚',
  '🧪',
  '🚀',
];

export interface AxisIconValue {
  icon?: string | null;
  color?: string | null;
}

const FALLBACK_ICON = {
  product: RiBox3Line,
  module: RiCodeSSlashLine,
  // A capability holds no icon and no colour of its own, so it always gets
  // this glyph and the colour that its name gives.
  capability: RiFocus3Line,
};

/** Renders a product, a module or a capability the same way everywhere. */
export function AxisIcon({
  kind,
  name,
  icon,
  color,
  className,
  size = DEFAULT_ICON_TILE,
}: AxisIconValue & {
  kind: 'product' | 'module' | 'capability';
  name: string;
  className?: string;
  /**
   * Sizes the tile and the glyph together. A caller that reaches for a height
   * class instead moves the tile and leaves the picture the size it was — which
   * is how the module rows ended up with a 14px picture in a 14px tile, filling
   * it corner to corner while every other row kept its margin.
   */
  size?: IconTileSize;
}) {
  const Fallback = FALLBACK_ICON[kind];
  const { tile, glyph } = ICON_TILE[size];

  return (
    <div
      className={cn(
        'shrink-0 rounded-sm flex items-center justify-center text-black',
        className,
      )}
      // The colour of a person with this name, before anybody picks one. The
      // alternative is grey for everything until somebody edits sixteen rows.
      style={{
        width: tile,
        height: tile,
        background: color ?? getTailwindColor(name),
      }}
      aria-hidden
    >
      {icon ? (
        <span className="leading-none" style={{ fontSize: glyph }}>
          {icon}
        </span>
      ) : (
        <Fallback size={glyph} className="shrink-0" />
      )}
    </div>
  );
}

export function AxisIconPicker({
  kind,
  name,
  icon,
  color,
  onChange,
}: AxisIconValue & {
  kind: 'product' | 'module';
  name: string;
  onChange: (value: AxisIconValue) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="px-1"
          aria-label="Change the icon"
        >
          <AxisIcon kind={kind} name={name} icon={icon} color={color} />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-3 flex flex-col gap-3" align="start">
        <div className="flex flex-wrap gap-1">
          {COLOURS.map((option) => (
            <button
              key={option}
              type="button"
              aria-label={`Colour ${option}`}
              className={cn(
                'h-5 w-5 rounded-sm',
                option === color && 'ring-2 ring-offset-1 ring-primary',
              )}
              style={{ background: option }}
              onClick={() => onChange({ icon, color: option })}
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {GLYPHS.map((glyph) => (
            <button
              key={glyph}
              type="button"
              className={cn(
                'h-6 w-6 rounded-sm hover:bg-grayAlpha-100',
                glyph === icon && 'bg-grayAlpha-100',
              )}
              onClick={() => onChange({ icon: glyph, color })}
            >
              {glyph}
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ icon: null, color: null })}
        >
          Reset
        </Button>
      </PopoverContent>
    </Popover>
  );
}
