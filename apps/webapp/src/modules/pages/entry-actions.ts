import { PageEntryStatus, type PageEntryType } from 'common/types';

/** One correction a person can make to a fact already decided about. */
export interface EntryAction {
  label: string;
  hint: string;
  change: { verified: true } | { status: PageEntryStatus };
}

/**
 * The corrections a fact's menu offers: the ones the server allows from where
 * it is. A fact written into the page is in use already, as the evidence the
 * page rests on, so it can only be taken out of use; put back, it is in use
 * on its own.
 */
export function entryActions(
  entry: Pick<PageEntryType, 'status' | 'verifiedAt'>,
): EntryAction[] {
  const actions: EntryAction[] = [];

  if (!entry.verifiedAt) {
    actions.push({
      label: 'Confirm',
      hint: 'Vouch for it. Confirmed facts are never retired automatically',
      change: { verified: true },
    });
  }

  if (
    entry.status !== PageEntryStatus.STANDING &&
    entry.status !== PageEntryStatus.CONSOLIDATED
  ) {
    actions.push({
      label: 'Use it',
      hint: 'Agents asking about this page start being given this fact',
      change: { status: PageEntryStatus.STANDING },
    });
  }

  if (entry.status !== PageEntryStatus.ARCHIVED) {
    actions.push({
      label: 'Stop using it',
      hint: 'Kept on the record, but no longer given to agents',
      change: { status: PageEntryStatus.ARCHIVED },
    });
  }

  if (entry.status !== PageEntryStatus.DISPUTED) {
    actions.push({
      label: 'Mark as wrong',
      hint: 'Flags it as contradicted and stops it being given to agents',
      change: { status: PageEntryStatus.DISPUTED },
    });
  }

  return actions;
}
