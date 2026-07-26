'use client';

import Dexie from 'dexie';

import type {
  ActionType,
  CompanyType,
  ConversationHistoryType,
  ConversationType,
  CycleType,
  IntegrationAccountType,
  PeopleType,
  ProjectMilestoneType,
  ProjectType,
  SupportType,
  TemplateType,
} from 'common/types';
import type { PageType, PageEntryType } from 'common/types';
import type {
  IssueType,
  IssueHistoryType,
  IssueCommentType,
  IssueSuggestionType,
  ChecklistItemType,
} from 'common/types';
import type { IssueRelationType } from 'common/types';
import type { LabelType } from 'common/types';
import type { LinkedIssueType } from 'common/types';
import type { NotificationType } from 'common/types';
import type { TeamType, WorkflowType } from 'common/types';
import type { ViewType } from 'common/types';
import type { UsersOnWorkspaceType, WorkspaceType } from 'common/types';

import { MODELS } from './models';
import { DEXIE_SCHEMA_VERSION } from './schema-version';

export class VantikDatabase extends Dexie {
  actions: Dexie.Table<ActionType, string>;
  workspaces: Dexie.Table<WorkspaceType, string>;
  labels: Dexie.Table<LabelType, string>;
  teams: Dexie.Table<TeamType, string>;
  workflows: Dexie.Table<WorkflowType, string>;
  issues: Dexie.Table<IssueType, string>;
  issueHistory: Dexie.Table<IssueHistoryType, string>;
  comments: Dexie.Table<IssueCommentType, string>;
  checklistItems: Dexie.Table<ChecklistItemType, string>;
  pages: Dexie.Table<PageType, string>;
  pageEntries: Dexie.Table<PageEntryType, string>;
  usersOnWorkspaces: Dexie.Table<UsersOnWorkspaceType, string>;
  integrationAccounts: Dexie.Table<IntegrationAccountType, string>;
  linkedIssues: Dexie.Table<LinkedIssueType, string>;
  issueRelations: Dexie.Table<IssueRelationType, string>;
  notifications: Dexie.Table<NotificationType, string>;
  views: Dexie.Table<ViewType, string>;
  issueSuggestions: Dexie.Table<IssueSuggestionType, string>;
  projects: Dexie.Table<ProjectType, string>;
  projectMilestones: Dexie.Table<ProjectMilestoneType, string>;
  cycles: Dexie.Table<CycleType, string>;
  conversations: Dexie.Table<ConversationType, string>;
  conversationHistory: Dexie.Table<ConversationHistoryType, string>;
  templates: Dexie.Table<TemplateType, string>;
  people: Dexie.Table<PeopleType, string>;
  company: Dexie.Table<CompanyType, string>;
  support: Dexie.Table<SupportType, string>;

  constructor(databaseName: string) {
    super(databaseName);

    this.version(DEXIE_SCHEMA_VERSION).stores({
      [MODELS.Workspace]: 'id,createdAt,updatedAt,name,slug,preferences',
      [MODELS.Label]:
        'id,createdAt,updatedAt,name,color,description,workspaceId,groupId,teamId',
      [MODELS.Team]:
        'id,createdAt,updatedAt,name,identifier,workspaceId,preferences,currentCycle',
      [MODELS.Workflow]:
        'id,createdAt,updatedAt,name,position,color,category,teamId,description',
      [MODELS.Issue]:
        'id,createdAt,updatedAt,title,number,description,priority,dueDate,sortOrder,estimate,teamId,createdById,assigneeId,labelIds,parentId,stateId,sourceMetadata.projectId,projectMilestoneId,cycleId',
      [MODELS.UsersOnWorkspaces]:
        'id,createdAt,updatedAt,userId,workspaceId,teamIds,settings,role,status',
      [MODELS.IssueHistory]:
        'id,createdAt,updatedAt,userId,issueId,assedLabelIds,removedLabelIds,fromPriority,toPriority,fromStateId,toStateId,fromEstimate,toEstimate,fromAssigneeId,toAssigneeId,fromParentId,toParentId,sourceMetadata',
      [MODELS.IssueComment]:
        'id,createdAt,updatedAt,userId,issueId,body,parentId,sourceMetadata',
      [MODELS.ChecklistItem]:
        'id,createdAt,updatedAt,body,completed,sortOrder,completedAt,completedById,issueId,createdById',
      [MODELS.IntegrationAccount]:
        'id,createdAt,updatedAt,accountId,settings,personal,integratedById,integrationDefinitionId,workspaceId',
      [MODELS.LinkedIssue]:
        'id,createdAt,updatedAt,url,sourceId,source,sourceData,issueId,createdById',
      [MODELS.IssueRelation]:
        'id,createdAt,updatedAt,issueId,createdById,type,relatedIssueId',
      [MODELS.Notification]:
        'id,createdAt,updatedAt,issueId,createdById,type,userId,actionData,sourceMetadata,readAt,workspaceId',
      [MODELS.View]:
        'id,createdAt,updatedAt,workspaceId,name,description,filters,isBookmarked,teamId',
      [MODELS.IssueSuggestion]:
        'id,createdAt,updatedAt,issueId,suggestedLabelIds,suggestedAssigneeId',
      [MODELS.Action]:
        'id,createdAt,updatedAt,workspaceId,config,data,status,version,name,description,integrations,createdById,slug,isPersonal',
      [MODELS.Project]:
        'id,createdAt,updatedAt,workspaceId,name,description,status,startDate,endDate,leadUserId,teams',
      [MODELS.ProjectMilestone]:
        'id,createdAt,updatedAt,projectId,name,description,endDate',
      [MODELS.Cycle]:
        'id,createdAt,updatedAt,teamId,name,description,endDate,startDate,preferences,number',
      [MODELS.Conversation]: 'id,createdAt,updatedAt,title,userId,workspaceId',
      [MODELS.ConversationHistory]:
        'id,createdAt,updatedAt,message,userType,context,thoughts,userId,conversationId',
      [MODELS.Template]:
        'id,createdAt,updatedAt,name,category,templateData,workspaceId,teamId',
      [MODELS.Support]:
        'id,createdAt,updatedAt,reportedById,actualFrtAt,firstResponseAt,nextResponseAt,resolvedAt,slaDueBy,metadata,issueId',
      [MODELS.Company]:
        'id,createdAt,updatedAt,name,domain,website,workspaceId,description,logo,industry,type,size,metadata',
      [MODELS.People]:
        'id,createdAt,updatedAt,name,email,phone,metadata,companyId,workspaceId',
      [MODELS.Page]:
        'id,createdAt,updatedAt,title,description,parentId,sortOrder,entryPolicy,visibility,workspaceId,createdById,updatedById',
      // Indexed on pageId and status: every read of this table is "the entries
      // on this page", usually narrowed to one status for the review rail.
      [MODELS.PageEntry]:
        'id,createdAt,updatedAt,content,scope,status,sourceUserId,sourceSession,verifiedByUserId,verifiedAt,retrievalCount,lastServedAt,supersedesId,pageId',
    });

    this.workspaces = this.table(MODELS.Workspace);
    this.labels = this.table(MODELS.Label);
    this.teams = this.table(MODELS.Team);
    this.workflows = this.table(MODELS.Workflow);
    this.issues = this.table(MODELS.Issue);
    this.usersOnWorkspaces = this.table(MODELS.UsersOnWorkspaces);
    this.issueHistory = this.table(MODELS.IssueHistory);
    this.comments = this.table(MODELS.IssueComment);
    this.checklistItems = this.table(MODELS.ChecklistItem);
    this.integrationAccounts = this.table(MODELS.IntegrationAccount);
    this.linkedIssues = this.table(MODELS.LinkedIssue);
    this.issueRelations = this.table(MODELS.IssueRelation);
    this.notifications = this.table(MODELS.Notification);
    this.views = this.table(MODELS.View);
    this.issueSuggestions = this.table(MODELS.IssueSuggestion);
    this.actions = this.table(MODELS.Action);
    this.projects = this.table(MODELS.Project);
    this.projectMilestones = this.table(MODELS.ProjectMilestone);
    this.cycles = this.table(MODELS.Cycle);
    this.conversations = this.table(MODELS.Conversation);
    this.conversationHistory = this.table(MODELS.ConversationHistory);
    this.templates = this.table(MODELS.Template);
    this.people = this.table(MODELS.People);
    this.company = this.table(MODELS.Company);
    this.support = this.table(MODELS.Support);
    this.pages = this.table(MODELS.Page);
    this.pageEntries = this.table(MODELS.PageEntry);
  }
}

export let vantikDatabase: VantikDatabase;

/** The hash of the workspace/user the open database belongs to. */
let databaseHash: number | undefined;

function schemaVersionKey(hash: number) {
  return `dexieSchemaVersion_${hash}`;
}

export function sequenceIdKey(hash: number) {
  return `lastSequenceId_${hash}`;
}

export function initDatabase(hash: number) {
  databaseHash = hash;

  const database = new VantikDatabase(`Vantik_${hash}`);

  // The store is shared by every tab on this origin, and the wipe below is
  // decided per tab from a localStorage key they all share. So a tab loading an
  // older bundle after a rollback deletes the database a newer tab is still
  // reading and writing. Dexie's default response in that tab is to close the
  // connection, which leaves it running against a store that is gone: reads
  // come back empty and socket deltas land nowhere, with nothing on screen
  // saying so until someone reloads by hand.
  //
  // Reloading is the honest answer. It re-enters `reconcileSchemaVersion`,
  // which decides afresh what this bundle can actually use, and it releases the
  // connection so the deleting tab is not left blocked.
  database.on('versionchange', () => {
    database.close();

    if (typeof window !== 'undefined') {
      window.location.reload();
    }

    return false;
  });

  vantikDatabase = database;
}

export async function resetDatabase() {
  // The sequence id is per workspace/user, and clearing the unsuffixed key
  // cleared nothing: bootstrap-data.tsx reads `lastSequenceId_<hash>`. A reset
  // that left it behind was worse than no reset at all — the next load saw a
  // sequence id, chose a delta sync over a bootstrap, and rebuilt an empty
  // store that would never recover the records written before that point.
  if (databaseHash !== undefined) {
    localStorage.removeItem(sequenceIdKey(databaseHash));
    localStorage.removeItem(schemaVersionKey(databaseHash));
  }

  if (vantikDatabase) {
    await vantikDatabase.delete();
  }
}

/**
 * Opens the database for `hash`, wiping it first if this bundle cannot use what
 * is stored.
 *
 * Dexie upgrades itself when the shipped version is *higher* than the stored
 * one, so the ordinary case needs no help. The case that needs handling is the
 * reverse — a client that ran a newer build and then loaded an older one, which
 * IndexedDB refuses outright — plus any other failure to open, since a database
 * we cannot open is worth less than the round trip to rebuild it.
 *
 * Entirely client-side by design. The server advertises versions and never
 * decides this, so there is no path by which it can order a client to discard
 * local data.
 *
 * @returns Whether the store was wiped, in which case the caller must
 * bootstrap from scratch rather than ask for a delta.
 */
export async function reconcileSchemaVersion(hash: number): Promise<boolean> {
  const key = schemaVersionKey(hash);
  const recorded = Number.parseInt(localStorage.getItem(key) ?? '', 10);
  const stored = Number.isNaN(recorded) ? undefined : recorded;

  let wiped = false;

  if (stored !== undefined && stored > DEXIE_SCHEMA_VERSION) {
    await resetDatabase();
    initDatabase(hash);
    wiped = true;
  }

  try {
    await vantikDatabase.open();
  } catch {
    // Includes Dexie's VersionError, but deliberately catches everything: a
    // corrupt or blocked database has the same remedy.
    await resetDatabase();
    initDatabase(hash);
    await vantikDatabase.open();
    wiped = true;
  }

  localStorage.setItem(key, `${DEXIE_SCHEMA_VERSION}`);

  return wiped;
}
