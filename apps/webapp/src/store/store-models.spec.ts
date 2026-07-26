import type { IAnyType, IModelType } from 'mobx-state-tree';

import { describe, expect, it } from 'vitest';

import { Action } from './action/models';
import { ChecklistItem } from './checklist-items/models';
import { Comment } from './comments/models';
import { Company } from './company/models';
import { ConversationHistory } from './conversation-history/models';
import { Conversation } from './conversations/models';
import { Cycle } from './cycle/models';
import { IntegrationAccount } from './integration-accounts/models';
import { IssueHistory } from './issue-history/models';
import { IssueRelation } from './issue-relation/models';
import { IssueSuggestion } from './issue-suggestions/models';
import { Issue } from './issues/models';
import { Label } from './labels/models';
import { LinkedIssue } from './linked-issues/models';
import { MODELS } from './models';
import { Notification } from './notifications/models';
import { PageEntry } from './page-entries/models';
import { Page } from './pages/models';
import { People } from './people/models';
import { Project, ProjectMilestone } from './projects/models';
import { Support } from './support/models';
import { Team } from './teams/models';
import { Template } from './templates/models';
import { getPrismaModel } from './test-support/prisma-schema';
import { View } from './views/models';
import { Workflow } from './workflows/models';
import { UsersOnWorkspace, Workspace } from './workspace/models';

/**
 * Every record the sync engine delivers is validated by MobX-State-Tree on the
 * way into the store, and the whole array is handed over at once. MST rejects
 * the entire snapshot when one element fails its type check, so a single row
 * carrying a null the model does not allow empties the list and the screen
 * behind it — that is exactly how every project disappeared from the sidebar
 * when `Project.status` was `types.string` against a nullable column.
 *
 * These tests hold the store models against schema.prisma so the next nullable
 * column fails here rather than in a view.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = IModelType<any, any>;

interface ModelUnderTest {
  /** The sync model name, which is also the key the payload arrives under. */
  syncName: MODELS;
  /** The model in schema.prisma this one mirrors. */
  prismaName: string;
  model: AnyModel;
  /**
   * Columns the store deliberately does not carry, with the reason. Keeping
   * them listed means an unexplained gap still fails.
   */
  ignoredFields?: Record<string, string>;
}

const MODELS_UNDER_TEST: ModelUnderTest[] = [
  { syncName: MODELS.Action, prismaName: 'Action', model: Action },
  {
    syncName: MODELS.ChecklistItem,
    prismaName: 'ChecklistItem',
    model: ChecklistItem,
  },
  { syncName: MODELS.IssueComment, prismaName: 'IssueComment', model: Comment },
  { syncName: MODELS.Company, prismaName: 'Company', model: Company },
  {
    syncName: MODELS.ConversationHistory,
    prismaName: 'ConversationHistory',
    model: ConversationHistory,
  },
  {
    syncName: MODELS.Conversation,
    prismaName: 'Conversation',
    model: Conversation,
  },
  { syncName: MODELS.Cycle, prismaName: 'Cycle', model: Cycle },
  {
    syncName: MODELS.IntegrationAccount,
    prismaName: 'IntegrationAccount',
    model: IntegrationAccount,
  },
  {
    syncName: MODELS.IssueHistory,
    prismaName: 'IssueHistory',
    model: IssueHistory,
  },
  {
    syncName: MODELS.IssueRelation,
    prismaName: 'IssueRelation',
    model: IssueRelation,
  },
  {
    syncName: MODELS.IssueSuggestion,
    prismaName: 'IssueSuggestion',
    model: IssueSuggestion,
  },
  { syncName: MODELS.Issue, prismaName: 'Issue', model: Issue },
  { syncName: MODELS.Label, prismaName: 'Label', model: Label },
  {
    syncName: MODELS.LinkedIssue,
    prismaName: 'LinkedIssue',
    model: LinkedIssue,
  },
  {
    syncName: MODELS.Notification,
    prismaName: 'Notification',
    model: Notification,
  },
  { syncName: MODELS.PageEntry, prismaName: 'PageEntry', model: PageEntry },
  { syncName: MODELS.Page, prismaName: 'Page', model: Page },
  { syncName: MODELS.People, prismaName: 'People', model: People },
  {
    syncName: MODELS.ProjectMilestone,
    prismaName: 'ProjectMilestone',
    model: ProjectMilestone,
  },
  { syncName: MODELS.Project, prismaName: 'Project', model: Project },
  { syncName: MODELS.Support, prismaName: 'Support', model: Support },
  { syncName: MODELS.Team, prismaName: 'Team', model: Team },
  { syncName: MODELS.Template, prismaName: 'Template', model: Template },
  {
    syncName: MODELS.UsersOnWorkspaces,
    prismaName: 'UsersOnWorkspaces',
    model: UsersOnWorkspace,
  },
  { syncName: MODELS.View, prismaName: 'View', model: View },
  { syncName: MODELS.Workflow, prismaName: 'Workflow', model: Workflow },
  { syncName: MODELS.Workspace, prismaName: 'Workspace', model: Workspace },
];

function propertyType(model: AnyModel, field: string): IAnyType | undefined {
  return (model.properties as Record<string, IAnyType>)[field];
}

describe('store models mirror schema.prisma', () => {
  describe.each(MODELS_UNDER_TEST)(
    '$syncName',
    ({ prismaName, model, ignoredFields = {} }) => {
      const prismaModel = getPrismaModel(prismaName);
      const nullableColumns = prismaModel.fields.filter(
        (field) => field.isOptional && !(field.name in ignoredFields),
      );

      it.each(nullableColumns)(
        'accepts a null $name, the way the column allows',
        ({ name }) => {
          const type = propertyType(model, name);

          if (!type) {
            // The store is free to carry fewer columns than the table has; it
            // only has to survive the ones it does carry.
            return;
          }

          expect(
            type.is(null),
            `${prismaName}.${name} is nullable in the database, but the store ` +
              `model declares it as ${type.name}. One row with a null here ` +
              `fails the type check for the whole array and empties the store.`,
          ).toBe(true);
        },
      );
    },
  );
});
