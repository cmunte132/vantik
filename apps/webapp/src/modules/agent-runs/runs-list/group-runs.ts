/* eslint-disable @typescript-eslint/no-explicit-any */

/** What the list needs to know about the issue a group of runs belongs to. */
export interface IssueLabel {
  /** `ENG-83`, or null when the issue or its team is not in the store. */
  key: string | null;
  title: string;
  /** For the link to the issue. Absent when the issue is not in the store. */
  number?: number;
}

export interface GroupedRun {
  run: any;
  /**
   * Which run this is on the issue, counting from the first.
   *
   * Deliberately not `run.attempt`, which counts retries of one run and is 1
   * for every run somebody delegated by hand. Four hand-delegated runs are
   * four attempts at the issue however the retry counter reads, and that is
   * the relationship this column exists to show.
   */
  ordinal: number;
}

export interface RunGroup {
  issueId: string;
  issue: IssueLabel;
  /** Newest first, which is the order somebody scanning this page reads in. */
  runs: GroupedRun[];
  /** When the most recent run started, for the group's own summary line. */
  latestAt: string;
}

/**
 * Runs, grouped by the issue they were working on.
 *
 * The flat list was a list of one issue's name repeated — seven consecutive
 * rows for one issue, each re-stating a title the row above already said and
 * each clipped at the same word. The title was also the widest column, so the
 * duplicated content was the content pushing the durations off the screen.
 *
 * Grouping is not decoration: it is what the data already is. Work happens per
 * issue, several attempts at a time, and "tried four times, out of budget
 * once, green on the fourth" is the most useful thing this page can say.
 *
 * The issue resolver is passed in rather than read from a store here, so the
 * shape of a group is testable without one.
 */
export function groupRunsByIssue(
  runs: any[],
  label: (issueId: string) => IssueLabel,
): RunGroup[] {
  const groups = new Map<string, any[]>();

  for (const run of runs) {
    const existing = groups.get(run.issueId);

    if (existing) {
      existing.push(run);
    } else {
      groups.set(run.issueId, [run]);
    }
  }

  return [...groups.entries()]
    .map(([issueId, found]) => {
      // Oldest first to number them, then reversed for display. Doing it in
      // one pass would number the newest run #1, which reads backwards.
      const oldestFirst = [...found].sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)),
      );

      const numbered = oldestFirst.map((run, index) => ({
        run,
        ordinal: index + 1,
      }));

      return {
        issueId,
        issue: label(issueId),
        runs: numbered.reverse(),
        latestAt: String(oldestFirst[oldestFirst.length - 1]?.createdAt ?? ''),
      };
    })
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

/**
 * A model id without the provider in front of it.
 *
 * `google/gemini-3.6-flash` and `~anthropic/claude-fable-latest` identify
 * themselves by their last segment; the prefix is the same on every row a
 * given key produced, so it is column width spent saying nothing.
 */
export function shortModel(modelId: string): string {
  return modelId.split('/').filter(Boolean).pop() ?? modelId;
}

/** A state read as a state, not as a log level. */
export function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
