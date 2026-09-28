const notes = (count: number) => `${count} ${count === 1 ? 'note' : 'notes'}`;

/** The patch, in words. `{ title: { from, to } }` is not a sentence. */
export function summarize(changes: Record<string, unknown>): string {
  if (changes.created) {
    return 'Created the page';
  }

  if (changes.revertedTo) {
    // Reverting an accepted consolidation puts its notes back in use.
    const unfolded = changes.unconsolidated as { to: number } | undefined;

    return unfolded
      ? `Restored an earlier version, and put ${notes(unfolded.to)} back in use`
      : 'Restored an earlier version';
  }

  if (changes.consolidated) {
    const count = (changes.consolidated as { to: number }).to;

    return `Wrote ${notes(count)} into the page`;
  }

  // A generated page's refresh: the gardener's edits, from the entries its
  // sections cite.
  if (changes.refreshed) {
    const { operations } = changes.refreshed as { operations: number };

    return operations > 0
      ? `Refreshed from its evidence: ${operations} ${operations === 1 ? 'edit' : 'edits'}`
      : 'Refreshed from its evidence: nothing to change';
  }

  const parts: string[] = [];

  if (changes.kind) {
    const { to } = changes.kind as { to: string };
    parts.push(
      to === 'AUTHORED' ? 'Taken over by hand' : 'Made a generated page',
    );
  }

  if (changes.question) {
    const { to } = changes.question as { to: string };
    parts.push(`Asked “${to}”`);
  }

  if (changes.title) {
    const { from, to } = changes.title as { from: string; to: string };
    parts.push(`Renamed “${from}” to “${to}”`);
  }

  if (changes.body) {
    parts.push('Edited the body');
  }

  if (changes.parentId) {
    parts.push('Moved the page');
  }

  if (changes.entryPolicy) {
    const { to } = changes.entryPolicy as { to: string };
    parts.push(`Set who may add facts to ${to.toLowerCase()}`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'Changed the page';
}
