import type { PageEntryMoveType } from 'common/types';

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

/**
 * "It lived outside pages, scoped to apps/server. The gardener found a page
 * it fits; Chris moved it · Sep 28".
 */
export function moveDetail(
  move: PageEntryMoveType,
  scope: string | null | undefined,
  titleOf: (pageId: string | null) => string,
  mover: string | null,
): string {
  const before = move.fromPageId
    ? `It was on ${titleOf(move.fromPageId)}.`
    : `It lived outside pages${scope ? `, scoped to ${scope}` : ''}.`;
  const how = move.suggested
    ? ` The gardener found a page it fits; ${mover ?? 'a person'} moved it`
    : ` ${mover ?? 'A person'} moved it`;

  return `${before}${how} · ${DATE.format(new Date(move.createdAt))}`;
}
