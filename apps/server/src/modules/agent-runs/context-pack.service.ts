import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunConfig, AgentRunRepoConfig } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssueContextService from 'modules/issues/issue-context.service';
import { LocalRepoService } from 'modules/local-repo/local-repo.service';

import { workspaceAgentDefaults } from './agent-run-settings';
import { chooseVerification } from './module-verification';
import { chooseRepo, isLocalSource, remoteUrlFor } from './repo-routing';

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
  /**
   * What the person delegating said, beyond what the issue records.
   *
   * Beside the Definition of Done rather than folded into the description, for
   * the same reason the criteria are: they are the standard the work is judged
   * against, the description is the problem, and this is neither — it is how
   * the person wants it approached. Folding it into the description would also
   * make the pack lie about what the issue says, and "what was the agent told"
   * has to stay answerable afterwards.
   */
  guidance?: string;
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
  private readonly logger = new Logger(ContextPackService.name);

  constructor(
    private prisma: PrismaService,
    private issueContext: IssueContextService,
    private localRepo: LocalRepoService,
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
    guidance?: string,
  ): Promise<ContextPack> {
    const [context, repo] = await Promise.all([
      this.issueContext.getIssueContext(issueId),
      this.resolveRepo(issueId, workspaceId, overrides),
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
      // Trimmed, and absent rather than empty: a blank string in the pack
      // becomes a blank heading in the prompt, which reads to a model as an
      // instruction it failed to receive.
      ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
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
   * What a run against this issue would open, without opening one.
   *
   * The delegation sheet states the executor, repository and base branch it is
   * about to use rather than making somebody expand a disclosure to find out.
   * That answer is the layered resolution below, and re-deriving it in the
   * client would mean two definitions of "which checkout" — with the client's
   * being the one that cannot see workspace preferences at all.
   *
   * Builds no pack: this is the cheap half, and it runs on every open of the
   * sheet.
   */
  async plan(
    issueId: string,
    workspaceId: string,
  ): Promise<AgentRunRepoConfig> {
    return this.resolveRepo(issueId, workspaceId);
  }

  /**
   * Repo configuration, layered: workspace defaults underneath, the issue's
   * own modules over them, the delegation request's overrides on top.
   *
   * The middle layer is what makes a workspace with several repositories work
   * without configuring anything per run. A module records where its code is
   * and how to check work in it, so an issue filed against a module has
   * already said which checkout the agent should open and how it proves the
   * change is sound. The workspace default is the answer for an issue that
   * names no module; an explicit request still wins over both, because a
   * person naming a repository knows something the map does not.
   *
   * Delivery is derived rather than defaulted to a constant. A workspace with
   * no remote configured has nowhere to push and no PR to open, so it gets a
   * worktree — which means a local-only install needs no configuration at all
   * to get something reviewable back.
   */
  private async resolveRepo(
    issueId: string,
    workspaceId: string,
    overrides?: AgentRunConfig,
  ): Promise<AgentRunRepoConfig> {
    const [workspace, routed] = await Promise.all([
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { preferences: true },
      }),
      this.repoForModules(issueId, workspaceId),
    ]);

    const defaults = workspaceAgentDefaults(workspace?.preferences);

    // Verification commands used to be configured here, at workspace level,
    // and a deployment may still hold a set from then. They stay honoured as
    // the bottom layer, so nothing that worked stops working — but a module
    // that says how to check its own code wins, because it is the one that
    // knows.
    const merged: AgentRunRepoConfig = {
      ...defaults.repo,
      ...routed,
      ...stripUndefined(repoFieldsOf(overrides)),
    };

    merged.delivery ??= merged.repoUrl ? 'pull_request' : 'worktree';

    return merged;
  }

  /**
   * What the issue's modules say: where the code is, and how to check it.
   *
   * Empty when the issue names no module, when its modules have no repository
   * recorded, or when they disagree — see `chooseRepo` for why disagreement is
   * not resolved by picking one.
   *
   * Verification is resolved separately from the repository and survives a
   * repository that could not be. The two answers are independent: modules in
   * two different repositories still agree on how to run the tests often
   * enough that throwing the commands away with the route would lose something
   * for nothing.
   */
  private async repoForModules(
    issueId: string,
    workspaceId: string,
  ): Promise<Partial<AgentRunRepoConfig>> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { moduleIds: true },
    });

    if (!issue?.moduleIds?.length) {
      return {};
    }

    const [rows, modules] = await Promise.all([
      this.prisma.moduleRepo.findMany({
        where: { moduleId: { in: issue.moduleIds }, deleted: null },
        select: {
          externalRepoId: true,
          fullName: true,
          integrationAccountId: true,
          pathPrefixes: true,
        },
      }),
      this.prisma.module.findMany({
        where: { id: { in: issue.moduleIds }, deleted: null },
        select: { verification: true },
      }),
    ]);

    const { verification, conflicts } = chooseVerification(modules);

    if (conflicts.length) {
      this.logger.warn({
        message:
          'The modules of this issue disagree on how to verify work, so the ' +
          `run does not ${conflicts.join(', ')}`,
        where: `${ContextPackService.name}.repoForModules`,
        issueId,
      });
    }

    const choice = chooseRepo(rows);

    if (!choice) {
      if (rows.length > 1) {
        this.logger.warn({
          message:
            'The modules of this issue are in more than one repository, so ' +
            'the run keeps the repository the workspace configured',
          where: `${ContextPackService.name}.repoForModules`,
          issueId,
        });
      }

      return verification;
    }

    const slug = await this.sourceSlug(choice.repo.integrationAccountId);
    const pathPrefixes = choice.prefixes;

    // A repository on this disk is opened where it already is. The path lives
    // in the settings of the integration account and not on the ModuleRepo
    // row, so it is read back rather than stored twice.
    if (isLocalSource(slug)) {
      const path = await this.localRepo.pathOf(
        workspaceId,
        choice.repo.externalRepoId,
      );

      return path
        ? { ...verification, repoPath: path, pathPrefixes }
        : verification;
    }

    const repoUrl = remoteUrlFor(slug, choice.repo.fullName);

    return repoUrl ? { ...verification, repoUrl, pathPrefixes } : verification;
  }

  /** The integration a repository came from, as its catalogue slug. */
  private async sourceSlug(
    integrationAccountId: string | null,
  ): Promise<string | null> {
    if (!integrationAccountId) {
      return null;
    }

    const account = await this.prisma.integrationAccount.findUnique({
      where: { id: integrationAccountId },
      select: { integrationDefinition: { select: { slug: true } } },
    });

    return account?.integrationDefinition?.slug ?? null;
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

/**
 * The repository fields of a delegation request, and nothing else.
 *
 * `AgentRunConfig` is a superset of the repo config — it also carries limits, a
 * harness command and a dry-run flag, which are the runner's business and not
 * part of "where is the code". Spreading the whole thing put all of them inside
 * `pack.repo`, where they mean nothing and read as though the repo had a
 * budget.
 */
function repoFieldsOf(config: AgentRunConfig | undefined): AgentRunRepoConfig {
  const {
    repoUrl,
    repoPath,
    pathPrefixes,
    delivery,
    worktreeRoot,
    baseBranch,
    branchPrefix,
    setupCommands,
    egressHosts,
    testCommand,
    lintCommand,
    typecheckCommand,
    buildCommand,
  } = config ?? {};

  return {
    repoUrl,
    repoPath,
    pathPrefixes,
    delivery,
    worktreeRoot,
    baseBranch,
    branchPrefix,
    setupCommands,
    egressHosts,
    testCommand,
    lintCommand,
    typecheckCommand,
    buildCommand,
  };
}

/** An override that was not supplied must not blank out the default under it. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
