import type { GroupHeader } from './grouping';

import { cn } from '@vantikhq/ui/lib/utils';

/**
 * The icon and the name of a group, on a chip of its colour. The list's header
 * and the board's column both show it; each wraps it in its own frame.
 */
export function groupChipStyle(header: GroupHeader) {
  return {
    className: cn(
      'rounded-2xl min-w-0',
      header.color ? 'text-accent-foreground' : 'bg-grayAlpha-100',
    ),
    style: header.color ? { backgroundColor: header.color } : undefined,
  };
}

export function GroupLabel({ header }: { header: GroupHeader }) {
  return (
    <>
      <span className="shrink-0 flex items-center">{header.icon}</span>
      <h3 className="pl-2 truncate">{header.name}</h3>
    </>
  );
}
