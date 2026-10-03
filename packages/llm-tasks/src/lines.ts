export interface LineRange {
  start: number;
  end: number;
}

/** "40-52" or "40", 1-based and inclusive, or null if it is neither. */
export function parseLineRange(text: string | undefined): LineRange | null {
  const match = /^\s*(\d{1,7})\s*(?:-\s*(\d{1,7})\s*)?$/.exec(text ?? '');

  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);

  return start >= 1 && end >= start ? { start, end } : null;
}

export function formatLineRange({ start, end }: LineRange): string {
  return start === end ? `${start}` : `${start}-${end}`;
}
