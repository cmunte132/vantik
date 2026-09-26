-- Actions are removed. A connected integration now reacts to its own events,
-- configured on its account, so nothing reads these tables: the Action row that
-- carried a vendor's triggers and team mappings, the entity rows that were its
-- triggers, the event log that deduplicated replication, and the schedules
-- that never fired. `actionsEnabled` gated deploying one.
DROP TABLE IF EXISTS "ActionSchedule";
DROP TABLE IF EXISTS "ActionEntity";
DROP TABLE IF EXISTS "ActionEvent";
DROP TABLE IF EXISTS "Action";

DROP TYPE IF EXISTS "ActionScheduleStatus";
DROP TYPE IF EXISTS "ActionStatus";

ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "actionsEnabled";

-- `ModelName` loses the labels of models that no longer exist: the two above,
-- and `TriggerProject` and `WorkspaceTriggerProject`, whose tables went with
-- trigger.dev. Postgres cannot drop a value from an enum, so the type is
-- rebuilt. A sync row still carrying one of these labels would fail the cast,
-- and it describes a record no client can load, so it goes first.
DELETE FROM "SyncAction"
WHERE "modelName"::text IN (
  'Action',
  'ActionEntity',
  'TriggerProject',
  'WorkspaceTriggerProject'
);

ALTER TYPE "ModelName" RENAME TO "ModelName_old";

CREATE TYPE "ModelName" AS ENUM (
  'AgentRun',
  'AgentRunEvent',
  'AgentRunIteration',
  'Attachment',
  'AIRequest',
  'Capability',
  'ChecklistItem',
  'Cycle',
  'Company',
  'Conversation',
  'ConversationHistory',
  'Emoji',
  'IntegrationAccount',
  'IntegrationDefinition',
  'IntegrationDefinitionV2',
  'Invite',
  'Issue',
  'IssueComment',
  'IssueHistory',
  'IssueRelation',
  'IssueSuggestion',
  'Label',
  'LinkedComment',
  'LinkedIssue',
  'Module',
  'Notification',
  'Page',
  'PageEntry',
  'PageHistory',
  'People',
  'Product',
  'Project',
  'ProjectMilestone',
  'Prompt',
  'Reaction',
  'Support',
  'SyncAction',
  'Team',
  'Template',
  'User',
  'UsersOnWorkspaces',
  'View',
  'Workflow',
  'Workspace'
);

ALTER TABLE "SyncAction"
  ALTER COLUMN "modelName" TYPE "ModelName"
  USING ("modelName"::text::"ModelName");

DROP TYPE "ModelName_old";
