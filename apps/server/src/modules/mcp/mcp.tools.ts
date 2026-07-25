import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VantikAgent } from '@vantikhq/agent-core';
import { z } from 'zod';

/**
 * Tool definitions for the Vantik MCP server.
 *
 * Descriptions are written for a model deciding *which* tool to call, so each
 * one says what the tool is for and when to reach for it — not just what it
 * does. Every tool delegates to agent-core, which is also what the CLI uses, so
 * the two surfaces can never drift apart.
 */

const stateCategory = z.enum([
  'TRIAGE',
  'BACKLOG',
  'UNSTARTED',
  'STARTED',
  'COMPLETED',
  'CANCELED',
]);

const priority = z.enum(['none', 'urgent', 'high', 'medium', 'low']);

const taskRef = z.string().describe('Task key such as ENG-42, or the task id.');

const projectRef = z
  .string()
  .describe('Project name or id. Call list_projects to see what exists.');

/** Tool results travel as text; JSON keeps them parseable by the model. */
function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

/**
 * Wraps a handler so a failed call reports back as a tool error rather than
 * crashing the request. Arguments arrive already validated against the tool's
 * zod schema, so the handler side is typed loosely on purpose.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handler(run: (input: any) => Promise<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (input: any) => {
    try {
      return text(JSON.stringify(await run(input), null, 2));
    } catch (error) {
      return {
        isError: true,
        ...text(error instanceof Error ? error.message : String(error)),
      };
    }
  };
}

/** Below this a description is a one-liner, not a problem statement. */
const MIN_DESCRIPTION_LENGTH = 40;

/**
 * The opinion the MCP surface enforces — and that the CLI and REST API
 * deliberately do not. An issue is a substantial chunk of work: one
 * self-contained feature, bug or objective, with enough for someone to pick it
 * up cold, not a line item. A top-level issue must state the problem and what
 * "done" looks like; a sub-task is held to a lighter bar, since its parent
 * already carries the objective — which is what makes one substantial issue
 * with sub-tasks cheaper than a scatter of thin siblings.
 *
 * Projects are the other half of the same opinion. Sub-tasks hold together the
 * steps of one issue; a project holds together the issues serving one
 * objective. Without it, work that genuinely spans several issues has nowhere
 * to be grouped, and the pressure to keep issues few turns into pressure to
 * cram unrelated things into one — so the tools push grouping upward into a
 * project rather than downward into a bloated issue.
 */
function assertSubstantialIssue(
  description: string,
  criteria: string[],
  isSubTask: boolean,
): void {
  const missing: string[] = [];
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    missing.push(
      `a description of the problem and where it lives (got ` +
        `${description.length} characters, need at least ` +
        `${MIN_DESCRIPTION_LENGTH})`,
    );
  }
  if (!isSubTask && criteria.length === 0) {
    missing.push('at least one acceptance criterion - what "done" looks like');
  }

  if (missing.length > 0) {
    throw new Error(
      'This issue is too thin to file. An issue is a substantial chunk of ' +
        'work - one self-contained feature, bug or objective, with enough ' +
        'for someone to pick it up cold - not a line item. It still needs: ' +
        `${missing.join('; ')}. If this is a small step, a passing thought, ` +
        'or part of an objective that already has an issue, add a note to ' +
        'that issue or file it as a sub-task instead of a new top-level ' +
        'issue - span as few issues as possible.',
    );
  }
}

/** Description followed by an acceptance-criteria checklist, when present. */
function composeIssueBody(description: string, criteria: string[]): string {
  if (criteria.length === 0) {
    return description;
  }
  const checklist = criteria.map((item) => `- [ ] ${item}`).join('\n');
  return `${description}\n\n## Acceptance criteria\n${checklist}`;
}

export function registerVantikTools(
  server: McpServer,
  agent: VantikAgent,
): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks in the workspace, newest first. Use this to see what is ' +
        'open, what is in progress, or what is assigned to someone. Returns ' +
        'lean rows without descriptions — call get_task for the full picture.',
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe(
            'Team identifier such as ENG. Omit in single-team workspaces.',
          ),
        assignee: z
          .string()
          .optional()
          .describe('Member email, full name, or "me" for the token owner.'),
        stateCategory: z
          .array(stateCategory)
          .optional()
          .describe('Restrict to these workflow categories.'),
        labels: z.array(z.string()).optional(),
        priority: priority.optional(),
        project: projectRef
          .optional()
          .describe('Only tasks in this project. Name or id.'),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(200).optional(),
      },
    },
    handler((input) => agent.listTasks(input)),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'The bodies of work in this workspace. A project groups the issues ' +
        'that serve one objective. Check this before filing: if what you are ' +
        'about to file belongs to an objective already underway, file it into ' +
        'that project rather than leaving it loose.',
      inputSchema: {},
    },
    handler(() => agent.listProjects()),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Open a project — the container for an objective that genuinely ' +
        'needs several issues. Reach for this the moment you are about to ' +
        'file the second or third issue serving the same goal: a handful of ' +
        'loose issues that only a reader who already knows the plan can ' +
        'connect is the thing a project exists to prevent. Check ' +
        'list_projects first and reuse what is there — projects should be ' +
        'few, long-lived and meaningful, not one per work session. Do not ' +
        'open one for a single issue; that issue is already the unit of work.',
      inputSchema: {
        name: z.string().describe('Short, durable name for the objective.'),
        description: z
          .string()
          .optional()
          .describe(
            'Markdown: what this objective is and what finishing it means.',
          ),
        status: z
          .string()
          .optional()
          .describe('Defaults to the workspace’s first status.'),
        startDate: z.string().optional().describe('ISO date.'),
        endDate: z.string().optional().describe('ISO date.'),
      },
    },
    handler((input) => agent.createProject(input)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task context',
      description:
        'Everything about one task in a single call: description, notes, ' +
        'full change history, sub-tasks, blocking relations and links. Call ' +
        'this before starting work on a task.',
      inputSchema: { task: taskRef },
    },
    handler(({ task }) => agent.getTask(task)),
  );

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description:
        'Search across task titles, descriptions AND notes. Set ' +
        'stateCategory to ["COMPLETED"] to find out whether something was ' +
        'fixed before — hits include the resolution text explaining how. Do ' +
        'this before filing a new task, to avoid duplicates.',
      inputSchema: {
        query: z
          .string()
          .describe('Free text, e.g. "connection pool timeout".'),
        stateCategory: z.array(stateCategory).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handler((input) => agent.searchTasks(input)),
  );

  server.registerTool(
    'find_similar_tasks',
    {
      title: 'Find similar tasks',
      description:
        'Prior tasks resembling this one, with how each was resolved. Use it ' +
        'to spot recurring problems and reuse an earlier fix.',
      inputSchema: { task: taskRef },
    },
    handler(({ task }) => agent.findSimilarTasks(task)),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'File an issue — one self-contained feature, bug or objective, with ' +
        'enough for someone to pick it up cold. An issue is substantial by ' +
        'default: a fair chunk of work, not a line item. When deciding how ' +
        'many issues a body of work should span, the answer is as few as ' +
        'possible — keep them few and meaty, not many and thin. Search ' +
        'first, and prefer adding to what exists: if this belongs to an ' +
        'objective that already has an issue, add_note to it, or pass ' +
        '`parent` to file a sub-task — do not open a new top-level issue for ' +
        'every thought or small step. A top-level issue must give a real ' +
        'description (the problem and where it lives) AND acceptanceCriteria ' +
        '(what "done" looks like); if you cannot state done, it is a note, ' +
        'not an issue. When this issue is one of several serving the same ' +
        'objective, group them: pass `project` naming an existing project, or ' +
        'open one with create_project first. Loose issues that only make ' +
        'sense together are how a tracker stops being readable. Lands in the ' +
        'team backlog unless a state is named.',
      inputSchema: {
        title: z.string(),
        description: z
          .string()
          .describe(
            'Markdown: the problem and where it lives. A title alone is a ' +
              'note, not an issue.',
          ),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe(
            'What "done" looks like, one item per criterion. Required for a ' +
              'top-level issue; optional for a sub-task, whose parent carries ' +
              'the objective. Rendered as a checklist on the issue.',
          ),
        team: z.string().optional(),
        state: z.string().optional(),
        labels: z.array(z.string()).optional(),
        priority: priority.optional(),
        assignee: z.string().optional(),
        parent: taskRef
          .optional()
          .describe('Create as a sub-task of this task.'),
        project: projectRef
          .optional()
          .describe(
            'The objective this issue serves. Use it whenever the work spans ' +
              'more than this one issue.',
          ),
      },
    },
    handler((input) => {
      // The opinion lives here, not in agent-core: hold the issue to the floor,
      // then compose the criteria into the body and hand a plain issue to the
      // neutral client.
      const { acceptanceCriteria, description, ...rest } = input;
      const criteria: string[] = (acceptanceCriteria ?? [])
        .map((item: string) => item.trim())
        .filter(Boolean);
      const body: string = (description ?? '').trim();

      assertSubstantialIssue(body, criteria, Boolean(rest.parent));

      return agent.createTask({
        ...rest,
        description: composeIssueBody(body, criteria),
      });
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Change a task’s title, description, state, labels, priority, ' +
        'assignee or project. Use `project` to gather issues that turned out ' +
        'to serve one objective under it, after the fact. To close a task use ' +
        'close_task instead, so the resolution is recorded.',
      inputSchema: {
        task: taskRef,
        title: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional(),
        labels: z.array(z.string()).optional(),
        priority: priority.optional(),
        assignee: z.string().optional(),
        project: projectRef.optional(),
      },
    },
    handler(({ task, ...rest }) => agent.updateTask(task, rest)),
  );

  server.registerTool(
    'pick_up_task',
    {
      title: 'Pick up task',
      description:
        'Take ownership: assigns the task and moves it into the team’s ' +
        'in-progress state. Call this when you start working, so the board ' +
        'shows the task is being handled.',
      inputSchema: {
        task: taskRef,
        assignee: z
          .string()
          .optional()
          .describe('Defaults to the token owner.'),
      },
    },
    handler(({ task, assignee }) => agent.pickUpTask(task, { assignee })),
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add note',
      description:
        'Post a note (comment) on a task in markdown. Use it to record what ' +
        'you tried, what you found, and anything the next person needs. Notes ' +
        'are searchable, so write them for a future reader.',
      inputSchema: {
        task: taskRef,
        body: z.string().describe('Markdown.'),
      },
    },
    handler(({ task, body }) => agent.addNote(task, body)),
  );

  server.registerTool(
    'close_task',
    {
      title: 'Close task',
      description:
        'Close a task, recording how it was resolved. Always pass a ' +
        'resolution: it is posted as a note before the state changes, which ' +
        'is what makes the fix findable the next time this problem appears.',
      inputSchema: {
        task: taskRef,
        resolution: z
          .string()
          .optional()
          .describe('Markdown explaining how it was resolved.'),
        state: z
          .string()
          .optional()
          .describe('Override the completed state, e.g. "Shipped".'),
      },
    },
    handler(({ task, ...rest }) => agent.closeTask(task, rest)),
  );
}
