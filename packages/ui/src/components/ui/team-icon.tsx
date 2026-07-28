import { HelpCentre, Code } from '../../icons';
import { getTeamColor } from '../../lib/color-utils';
import {
  DEFAULT_ICON_TILE,
  ICON_TILE,
  type IconTileSize,
} from '../../lib/icon-tile';
import { cn } from '../../lib/utils';

export interface TeamIconProps {
  name: string;
  className?: string;
  icon?: string;
  /**
   * Sizes the tile and the glyph together. A caller that reaches for a height
   * class instead moves the tile and leaves the picture the size it was.
   */
  size?: IconTileSize;
  preferences?: {
    teamType?: string;
  };
}

export function TeamIcon({
  name,
  className,
  preferences,
  size = DEFAULT_ICON_TILE,
}: TeamIconProps) {
  const Icon = preferences?.teamType === 'support' ? HelpCentre : Code;
  const { tile, glyph } = ICON_TILE[size];

  return (
    <div
      className={cn(
        `shrink-0 rounded-sm flex items-center justify-center text-black`,
        className,
      )}
      style={{
        width: tile,
        height: tile,
        background: name ? getTeamColor(name) : undefined,
      }}
    >
      <Icon size={glyph} className="shrink-0" />
    </div>
  );
}
