/**
 * The team identifier inside a route parameter like `ENG-89`.
 *
 * The inbox route names an issue the way a person does, by team identifier and
 * number. Both halves are needed to find it: a number belongs to a team, so
 * `89` on its own names one issue per team in the workspace.
 */
export function teamIdentifierOf(
  issueParam: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(issueParam) ? issueParam[0] : issueParam;

  if (typeof raw !== 'string') {
    return undefined;
  }

  const [identifier, number] = raw.split('-');

  // Both halves have to be there. A parameter with no number is not an issue,
  // and answering with the identifier alone would match the first issue of
  // that team rather than none.
  if (!identifier || !number) {
    return undefined;
  }

  return identifier;
}

/**
 * Whether the divider under an inbox row is hidden.
 *
 * The open row carries a background, and a divider along the edge it shares
 * with a neighbour would cut across that block, so the rows on both sides of
 * it drop theirs.
 *
 * Issues are compared by id. Each row used to rebuild `ENG-89` from its own
 * team's identifier and test the *next* row's issue against it, so an issue
 * in another team that shared a number counted as the same row — and two
 * teams both numbering from 1 is the ordinary case.
 */
export function dividerHidden(
  issueId: string,
  nextIssueId: string | undefined,
  selectedIssueId: string | undefined,
): boolean {
  if (!selectedIssueId) {
    return false;
  }

  return issueId === selectedIssueId || nextIssueId === selectedIssueId;
}
