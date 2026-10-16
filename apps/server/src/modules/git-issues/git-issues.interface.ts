/**
 * How often each local repository's issue mirror is brought up to date:
 * inboxes applied, snapshot rewritten. Empty or `off` disables it.
 *
 * Every minute because this is the whole of an agent's round trip. A pass
 * that finds nothing new costs a few aggregate queries and one `for-each-ref`
 * per repository, and writes nothing.
 */
export const GIT_ISSUES_CRON = process.env.GIT_ISSUES_CRON ?? '* * * * *';

export const GIT_ISSUES_QUEUE = 'git-issues';
export const GIT_ISSUES_JOB = 'syncGitIssues';

/** Fixed, so each replica registering the schedule does not add another. */
export const GIT_ISSUES_JOB_ID = 'git-issues-sync';
