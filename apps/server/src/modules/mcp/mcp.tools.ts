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

/**
 * The knowledge bank's half of the same opinion, and the same division of
 * labour.
 *
 * The *mechanical* limits — a page's entry policy, the per-token budget on
 * untriaged entries, the two-phase write when near matches exist — live on the
 * server and apply to every caller, because a tool description asking for
 * restraint is advisory and fails against exactly the unfamiliar models this
 * feature exists to serve.
 *
 * What lives here is the editorial floor: an entry is *one* fact, and a page is
 * a thing to add to rather than a thing to create. Both failures look the same
 * from the outside — a bank that grows faster than anyone can read it — but
 * only one of them is worth failing a call over, and it is the one where the
 * caller has clearly dumped a session summary into a field meant for a claim.
 */
const MAX_ENTRY_CONTENT_LENGTH = 600;
const MIN_ENTRY_CONTENT_LENGTH = 15;

function assertAtomicFact(content: string): void {
  const trimmed = content.trim();

  if (trimmed.length < MIN_ENTRY_CONTENT_LENGTH) {
    throw new Error(
      'That is too short to be a fact anyone can act on later. An entry ' +
        'should state one thing that is true, with enough context that a ' +
        'reader who was not in this session understands it.',
    );
  }

  if (trimmed.length > MAX_ENTRY_CONTENT_LENGTH) {
    throw new Error(
      `An entry is one self-contained fact, not a summary (got ` +
        `${trimmed.length} characters, the ceiling is ` +
        `${MAX_ENTRY_CONTENT_LENGTH}). If this is several facts, remember ` +
        'them one at a time so each can be scoped, verified and superseded ' +
        'on its own. If it is narrative, it belongs in a page body — call ' +
        'write_page or consolidate_knowledge instead.',
    );
  }

  // A bulleted list in a single entry is the commonest way one claim becomes
  // six: each bullet is separately true, separately falsifiable, and separately
  // worth superseding, and none of that is possible once they share a row.
  const bullets = trimmed
    .split('\n')
    .filter((line) => /^\s*[-*+]\s|^\s*\d+[.)]\s/.test(line));

  if (bullets.length > 2) {
    throw new Error(
      `This reads as ${bullets.length} facts in one entry. Remember them ` +
        'separately — an entry that bundles claims cannot be scoped, ' +
        'verified or superseded one claim at a time, which is the whole ' +
        'reason entries are atomic.',
    );
  }
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
      // then hand the criteria to the neutral client, which files them as real
      // checklist items rather than as markdown in the description.
      const { acceptanceCriteria, description, ...rest } = input;
      const criteria: string[] = (acceptanceCriteria ?? [])
        .map((item: string) => item.trim())
        .filter(Boolean);
      const body: string = (description ?? '').trim();

      assertSubstantialIssue(body, criteria, Boolean(rest.parent));

      return agent.createTask({
        ...rest,
        description: body,
        acceptanceCriteria: criteria,
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

  // ------------------------------------------------------- knowledge bank

  server.registerTool(
    'load_context',
    {
      title: 'Load what the workspace already knows',
      description:
        'Call this FIRST, before starting work on anything. Returns what the ' +
        'workspace has already established about the area you are about to ' +
        'touch — decisions, gotchas, conventions — under a token budget you ' +
        'set. This is the cheapest way to avoid rediscovering something a ' +
        'previous session already paid for, and it works across harnesses: ' +
        'knowledge another tool wrote is knowledge you get. Give it a scope ' +
        '(the repo path or area you are working in) even if you have no ' +
        'specific question, because at the start of a task you do not yet ' +
        'know what you do not know.',
      inputSchema: {
        task: z
          .string()
          .optional()
          .describe('What you are about to do, in a sentence.'),
        scope: z
          .string()
          .optional()
          .describe('Where you are working, e.g. "apps/server/prisma".'),
        tokenBudget: z
          .number()
          .int()
          .min(200)
          .max(20000)
          .optional()
          .describe('How much context you can afford. Defaults to 2000.'),
      },
    },
    handler((input) => agent.loadContext(input)),
  );

  server.registerTool(
    'recall_knowledge',
    {
      title: 'Recall knowledge',
      description:
        'Ask the workspace what it knows about something — "how do we handle ' +
        'migrations", "why is redis only a cache here". Searches page bodies ' +
        'and the facts agents have asserted, newest and best-established ' +
        'first, with who asserted each and whether a human confirmed it. Use ' +
        'this before investigating something from scratch; the answer may ' +
        'already be in the bank.',
      inputSchema: {
        query: z.string().describe('What you want to know.'),
        scope: z
          .string()
          .optional()
          .describe('Narrow to a repo path, team or project.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    handler((input) => agent.recallKnowledge(input)),
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List knowledge pages',
      description:
        'The pages this workspace keeps. Check here before writing anything ' +
        'down: knowledge belongs *on* an existing page far more often than it ' +
        'belongs on a new one, and a bank of forty thin pages is one nobody ' +
        'can navigate. Pages are few, broad and long-lived; the facts under ' +
        'them are many.',
      inputSchema: {},
    },
    handler(() => agent.listPages()),
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a knowledge page',
      description:
        'One page in full: its body as markdown, where it sits in the tree, ' +
        'and the facts currently being served from it. Read the page before ' +
        'adding to it — the thing you are about to assert may already be in ' +
        'the body, in which case there is nothing to add.',
      inputSchema: {
        page: z.string().describe('Page title or id.'),
      },
    },
    handler(({ page }) => agent.readPage(page)),
  );

  server.registerTool(
    'pages_for',
    {
      title: 'Pages about a team, project or issue',
      description:
        'The documentation attached to one thing in the workspace. Use this ' +
        'the moment you are handed an issue or a project, before you search: ' +
        'you have an id and no vocabulary, so you cannot write the query that ' +
        'would find the page — you do not yet know it is called “Deploying ' +
        'the worker pool”. This is a direct lookup and does not guess.\n\n' +
        'Search is for questions. This is for “what has already been written ' +
        'down about the thing in front of me”.',
      inputSchema: {
        entityType: z
          .enum(['TEAM', 'PROJECT', 'ISSUE', 'PAGE'])
          .describe('What kind of thing you are starting from.'),
        entityId: z.string().describe('Its id.'),
      },
    },
    handler(({ entityType, entityId }) =>
      agent.pagesFor({ entityType, entityId }),
    ),
  );

  server.registerTool(
    'link_page',
    {
      title: 'Link a page to work',
      description:
        'Attach a page to the team, project or issue it is about, so the next ' +
        'agent handed that work is given the page without having to find it.\n\n' +
        'Link when the connection is durable — this runbook governs this ' +
        'project, this page explains this team’s conventions. Do not link a ' +
        'page to every issue that happened to touch it: a page attached to ' +
        'forty issues tells the next reader nothing about which of them it ' +
        'actually explains.',
      inputSchema: {
        page: z.string().describe('Page title or id.'),
        entityType: z.enum(['TEAM', 'PROJECT', 'ISSUE', 'PAGE']),
        entityId: z.string().describe('The id of the thing to link it to.'),
      },
    },
    handler(({ page, entityType, entityId }) =>
      agent.linkPage({ page, entityType, entityId }),
    ),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember a fact',
      description:
        'Write one thing you learned into the workspace’s memory, so the next ' +
        'session — yours or another tool’s — does not have to learn it again. ' +
        'This is the main way knowledge gets in.\n\n' +
        'An entry is ONE self-contained fact, with a scope saying where it ' +
        'applies. Not a summary of what you did, not a list. If you learned ' +
        'six things, call this six times: each fact can then be scoped, ' +
        'confirmed and corrected on its own.\n\n' +
        'Prefer an existing page. If the fact contradicts something already ' +
        'in the bank, supersede that entry rather than leaving a second truth ' +
        'beside the first — two contradictory facts are worse than neither, ' +
        'because a reader cannot tell which one the workspace believes.\n\n' +
        'The call searches before it writes. If near matches come back, ' +
        'nothing was written: read them, then either supersede one or say ' +
        'the fact is distinct.',
      inputSchema: {
        page: z.string().describe('Page title or id to append to.'),
        content: z
          .string()
          .describe('One fact, in markdown. Write it for a stranger.'),
        scope: z
          .string()
          .optional()
          .describe(
            'Where it applies — a repo path glob, team or project. A fact ' +
              'without a scope is served everywhere, so scope it when it is ' +
              'not true of the whole workspace.',
          ),
        session: z
          .string()
          .optional()
          .describe('Your session id, so the claim can be traced back.'),
        supersedes: z
          .string()
          .optional()
          .describe('Id of the entry this one replaces.'),
        distinct: z
          .boolean()
          .optional()
          .describe(
            'Set only after reading the near matches and deciding this is a ' +
              'separate fact.',
          ),
      },
    },
    handler((input) => {
      // The editorial floor lives here and nowhere below: agent-core, the CLI
      // and the REST API accept whatever a caller sends.
      assertAtomicFact(input.content);
      return agent.remember(input);
    }),
  );

  server.registerTool(
    'write_page',
    {
      title: 'Write a knowledge page',
      description:
        'Create or rewrite a page — the narrative documentation a human ' +
        'reads. Reach for this rarely. Most of what you learn is a fact, not ' +
        'a document: call remember instead, and let a person fold the facts ' +
        'into prose when a shape emerges. Open a new page only when there is ' +
        'genuinely no existing page the knowledge belongs under; check ' +
        'list_pages first. A page needs a real body — a title with nothing ' +
        'underneath it is a stub that makes the tree worse, not better.',
      inputSchema: {
        title: z.string(),
        body: z.string().describe('Markdown. The page as a reader sees it.'),
        parent: z
          .string()
          .optional()
          .describe('Parent page title or id, to nest this under it.'),
        entryPolicy: z
          .enum(['OPEN', 'CURATED', 'LOCKED'])
          .optional()
          .describe('How strictly appends to this page are policed.'),
      },
    },
    handler((input) => {
      if (!input.body?.trim()) {
        throw new Error(
          'A page needs a body. A title with nothing underneath it is a stub ' +
            'that makes the tree harder to navigate without adding anything ' +
            'to it. If you have a fact rather than a document, call remember ' +
            'against an existing page instead.',
        );
      }
      return agent.writePage(input);
    }),
  );

  server.registerTool(
    'consolidate_knowledge',
    {
      title: 'Consolidate knowledge into a page',
      description:
        'Fold standing facts into a page body and mark them consolidated, so ' +
        'the same thing is not served twice — once as narrative and once as ' +
        'the entry it was written from. This is how the bank stays small ' +
        'enough to stay useful; do it when a page has accumulated facts that ' +
        'now read as a paragraph. You supply the rewritten body, because ' +
        'deciding how a set of facts reads as prose is the judgment being ' +
        'asked for.',
      inputSchema: {
        page: z.string().describe('Page title or id.'),
        body: z.string().describe('The rewritten page body, in markdown.'),
        entryIds: z
          .array(z.string())
          .optional()
          .describe('Entries folded in. Omit to fold every standing entry.'),
      },
    },
    handler((input) => agent.consolidate(input)),
  );

  server.registerTool(
    'knowledge_gaps',
    {
      title: 'Knowledge gaps',
      description:
        'Questions agents asked that the bank could not answer, most-asked ' +
        'first. The most direct answer available to "what should I document ' +
        'next" — it says what people actually needed, rather than what ' +
        'somebody thought to write down.',
      inputSchema: {},
    },
    handler(() => agent.knowledgeGaps()),
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
