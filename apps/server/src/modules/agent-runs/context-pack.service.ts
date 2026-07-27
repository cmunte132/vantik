import { Injectable } from '@nestjs/common';
import type { AgentRunConfig, AgentRunRepoConfig } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssueContextService from 'modules/issues/issue-context.service';

import { workspaceAgentDefaults } from './agent-run-settings';

/**
 * What an agent is handed when it picks up a run.
 *
 * Snapshotted at dispatch rather than fetched by the runner, for three
 * reasons. Every executor gets the same thing, so a run is comparable across
 * backends. The runner needs no read access to the issue graph beyond its own
 * run. And the pack stays fixed while the issue underneath it is edited —
 * otherwise "what was the agent told" becomes unanswerable the moment someone
 * tidies the description.
 */
export interface ContextPack {
  /** Bumped when the shape changes, so a stored pack stays readable. */
  version: 1;
  issue: {
    id: string;
    key: string;
    title: string;
    /** Markdown. Never tiptap JSON — no executor should have to know that exists. */
    description: string;
    state: string | null;
    stateCategory: string | null;
    priority: string | null;
    labels: string[];
    team: { id: string; identifier: string; name: string };
    project: { id: string; name: string } | null;
    url: string | null;
  };
  /**
   * The Definition of Done, verbatim.
   *
   * The bar the work is judged against, and the input ENG-62 derives its test
   * suites from. Passed as structured criteria rather than folded into the
   * description, because a criterion the agent can tick is a different object
   * from a sentence it can paraphrase.
   */
  definitionOfDone: Array<{ id: string; body: string; completed: boolean }>;
  subTasks: Array<{ key: string; title: string; done: boolean }>;
  /** Blocking and related work, so the agent knows what it must not break. */
  relations: Array<{ type: string; key: string; title: string }>;
  comments: Array<{ author: string | null; at: string; body: string }>;
  links: Array<{ url: string; title: string | null }>;
  /**
   * How to build, run and verify this repository.
   *
   * The highest-leverage thing in the pack. Whether the agent can run the
   * repo's own tests and react to the output is the difference between a
   * plausible diff and a working one — worth more than a better model. Without
   * it every runner re-derives the commands by guessing, and "the agent could
   * not run anything" is the most common failure these systems have.
   */
  repo: AgentRunRepoConfig;
  /** Set when a knowledge bank is wired up; empty until then. */
  knowledge: Array<{ scope: string; body: string }>;
}

@Injectable()
export class ContextPackService {
  constructor(
    private prisma: PrismaService,
    private issueContext: IssueContextService,
  ) {}

  /**
   * Assembles the pack for one issue.
   *
   * Built on `IssueContextService`, which already walks the issue graph and
   * resolves every id to a name for `get_task`. Re-walking it here would mean
   * two definitions of "the working context of an issue" drifting apart, and
   * the agent surface is exactly where they must not.
   */
  async build(
    issueId: string,
    workspaceId: string,
    overrides?: AgentRunConfig,
  ): Promise<ContextPack> {
    const [context, repo] = await Promise.all([
      this.issueContext.getIssueContext(issueId),
      this.resolveRepo(workspaceId, overrides),
    ]);

    return {
      version: 1,
      issue: {
        id: context.id,
        key: context.key,
        title: context.title,
        description: context.descriptionMarkdown ?? '',
        state: context.state?.name ?? null,
        stateCategory: context.state?.category ?? null,
        priority: priorityName(context.priority),
        labels: context.labels.map((label) => label.name),
        team: {
          id: context.team.id,
          identifier: context.team.identifier,
          name: context.team.name,
        },
        project: context.project
          ? { id: context.project.id, name: context.project.name }
          : null,
        url: issueUrl(context.key),
      },
      definitionOfDone: context.criteria.map((criterion) => ({
        id: criterion.id,
        body: criterion.body,
        completed: criterion.completed,
      })),
      subTasks: context.subIssues.map((sub) => ({
        key: sub.key,
        title: sub.title,
        done: sub.stateCategory === 'COMPLETED',
      })),
      relations: context.relations.map((relation) => ({
        type: relation.type,
        key: relation.issue.key,
        title: relation.issue.title,
      })),
      comments: context.comments.map((comment) => ({
        author: comment.author?.fullname ?? null,
        at: comment.createdAt.toISOString(),
        body: comment.bodyMarkdown ?? '',
      })),
      links: context.linkedIssues.map((linked) => ({
        url: linked.url,
        title: linked.title ?? null,
      })),
      repo,
      // Reserved for the Pages knowledge bank (ENG-52..ENG-54). When it lands,
      // STANDING entries and linked pages join the pack here and every
      // executor gets them without a single adapter changing.
      knowledge: [],
    };
  }

  /**
   * Repo configuration, layered: workspace defaults underneath, the
   * delegation request's overrides on top.
   *
   * Delivery is derived rather than defaulted to a constant. A workspace with
   * no remote configured has nowhere to push and no PR to open, so it gets a
   * worktree — which means a local-only install needs no configuration at all
   * to get something reviewable back.
   */
  private async resolveRepo(
    workspaceId: string,
    overrides?: AgentRunConfig,
  ): Promise<AgentRunRepoConfig> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });

    const defaults = workspaceAgentDefaults(workspace?.preferences);

    const merged: AgentRunRepoConfig = {
      ...defaults.repo,
      ...stripUndefined(overrides ?? {}),
    };

    merged.delivery ??= merged.repoUrl ? 'pull_request' : 'worktree';

    return merged;
  }
}

function priorityName(priority: number | null): string | null {
  const names = ['none', 'urgent', 'high', 'medium', 'low'];
  return priority == null ? null : (names[priority] ?? null);
}

/**
 * The issue's address in the webapp, when the deployment advertises one.
 *
 * Handy in a PR body and a summary comment, and absent rather than wrong on a
 * deployment that has not set FRONTEND_HOST.
 */
function issueUrl(key: string): string | null {
  const host = process.env.FRONTEND_HOST?.replace(/\/+$/, '');
  return host ? `${host}/issue/${key}` : null;
}

/** An override that was not supplied must not blank out the default under it. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
