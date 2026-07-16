import { LinkedIssue } from '@vantikhq/types';

import { IssueWithRelations } from 'modules/issues/issues.interface';

export interface LinkedIssueWithRelations extends LinkedIssue {
  issue: IssueWithRelations;
}

export const githubIssueRegex =
  /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/issues\/\d+$/;

export const githubPRRegex =
  /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/pull\/\d+$/;

// export const githubPRRegex = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export const sentryRegex =
  /^https:\/\/(?<orgSlug>.+)\.sentry\.io\/issues\/(?<sentryIssueId>\d+)\//;
