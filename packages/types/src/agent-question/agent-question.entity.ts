/**
 * A question that an agent asks a person during a run.
 *
 * One record serves every harness. A hosted Pi run and a local omp run write
 * the same row, the person answers it the same way, and it shows in the same
 * place. The record names the run it came from. The run id is optional, so a
 * terminal session can ask later.
 */

export const AGENT_QUESTION_STATUSES = [
  'OPEN',
  'ANSWERED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type AgentQuestionStatus = (typeof AGENT_QUESTION_STATUSES)[number];

/**
 * Where the question came from. `tool` is the `ask_person` tool of the Vantik
 * extension. `omp_dialog` is a dialog that omp itself opened (a select, a
 * confirmation or an input) and that the connector forwarded.
 */
export const AGENT_QUESTION_SOURCES = ['tool', 'omp_dialog'] as const;

export type AgentQuestionSource = (typeof AGENT_QUESTION_SOURCES)[number];

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

/** One question. The shape follows omp's AskQuestion, so omp dialogs map in. */
export interface AgentQuestionItem {
  /** Unique inside the record. The answer names it. */
  id: string;
  prompt: string;
  /** Absent for a free-text question. */
  options?: AgentQuestionOption[];
  /** The person may pick more than one option. */
  multiple?: boolean;
  /** The person may type an answer that is not an option. */
  allowOther?: boolean;
}

export interface AgentQuestionAnswer {
  /** The id of the question that this answers. */
  id: string;
  /** The labels of the options that the person picked. */
  selected: string[];
  /** The text that the person typed instead of, or as well as, an option. */
  other?: string;
}

/** The bounds that the server holds a question to. The agent wrote it. */
export const AGENT_QUESTION_LIMITS = {
  /** Questions in one record. */
  questions: 4,
  /** Records one run may open. */
  perRun: 5,
  id: 64,
  prompt: 500,
  options: 6,
  label: 120,
  description: 300,
  other: 2000,
} as const;

/**
 * The ids a question may have. The id becomes a file name on the agent's
 * machine, and the agent chose it, so it is a plain token and never a path.
 */
export const AGENT_QUESTION_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** How long a question waits for a person when nothing else says. */
export const AGENT_QUESTION_DEFAULT_WAIT_MS = 30 * 60 * 1000;

/** The most that a run may set the wait to. */
export const AGENT_QUESTION_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The questions of a record, checked and cut to the limits. Returns a string
 * that says what is wrong when they cannot be used. Pure: the server and the
 * connector read the same rules.
 */
export function parseAgentQuestions(
  value: unknown,
): AgentQuestionItem[] | string {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > AGENT_QUESTION_LIMITS.questions
  ) {
    return `Ask 1 to ${AGENT_QUESTION_LIMITS.questions} questions.`;
  }

  const items: AgentQuestionItem[] = [];
  const ids = new Set<string>();

  for (const raw of value) {
    if (!isRecord(raw)) {
      return 'Each question must be an object.';
    }

    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';

    if (!id || id.length > AGENT_QUESTION_LIMITS.id || ids.has(id)) {
      return 'Each question needs its own short id.';
    }
    if (!prompt || prompt.length > AGENT_QUESTION_LIMITS.prompt) {
      return `A prompt must have 1 to ${AGENT_QUESTION_LIMITS.prompt} characters.`;
    }
    ids.add(id);

    const item: AgentQuestionItem = { id, prompt };

    if (raw.options !== undefined && raw.options !== null) {
      if (
        !Array.isArray(raw.options) ||
        raw.options.length === 0 ||
        raw.options.length > AGENT_QUESTION_LIMITS.options
      ) {
        return `A question has 1 to ${AGENT_QUESTION_LIMITS.options} options, or none.`;
      }

      const labels = new Set<string>();
      item.options = [];

      for (const option of raw.options) {
        const label =
          isRecord(option) && typeof option.label === 'string'
            ? option.label.trim()
            : '';

        if (
          !label ||
          label.length > AGENT_QUESTION_LIMITS.label ||
          labels.has(label)
        ) {
          return 'Each option needs its own short label.';
        }
        labels.add(label);

        const description =
          isRecord(option) && typeof option.description === 'string'
            ? option.description
                .trim()
                .slice(0, AGENT_QUESTION_LIMITS.description)
            : '';

        item.options.push({
          label,
          ...(description ? { description } : {}),
        });
      }
    }

    if (raw.multiple === true) {
      item.multiple = true;
    }
    if (raw.allowOther === true) {
      item.allowOther = true;
    }

    items.push(item);
  }

  return items;
}

/**
 * The answers of a person, checked against the questions. Returns a string
 * that says what is wrong when they cannot be used.
 *
 * A question without options takes free text. A question with options takes
 * labels from the list, one unless it allows more, and takes typed text only
 * when it allows other answers. Every question needs an answer.
 */
export function parseAgentAnswers(
  questions: AgentQuestionItem[],
  value: unknown,
): AgentQuestionAnswer[] | string {
  if (!Array.isArray(value)) {
    return 'Send the answers as a list.';
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of value) {
    if (isRecord(raw) && typeof raw.id === 'string') {
      if (byId.has(raw.id)) {
        return `Question ${raw.id} is answered twice.`;
      }
      byId.set(raw.id, raw);
    }
  }

  const answers: AgentQuestionAnswer[] = [];

  for (const question of questions) {
    const raw = byId.get(question.id);

    if (!raw) {
      return `Answer the question "${question.id}".`;
    }

    const selected = Array.isArray(raw.selected)
      ? raw.selected.filter(
          (label): label is string => typeof label === 'string',
        )
      : [];
    const other = typeof raw.other === 'string' ? raw.other.trim() : '';
    const labels = new Set(question.options?.map((option) => option.label));

    if (
      new Set(selected).size !== selected.length ||
      selected.some((label) => !labels.has(label))
    ) {
      return `Question "${question.id}" has an answer that is not one of its options.`;
    }
    if (!question.multiple && selected.length > 1) {
      return `Question "${question.id}" takes one option.`;
    }
    if (other.length > AGENT_QUESTION_LIMITS.other) {
      return `The text for question "${question.id}" is too long.`;
    }
    if (other && question.options && !question.allowOther) {
      return `Question "${question.id}" takes only its options.`;
    }
    if (selected.length === 0 && !other) {
      return `Answer the question "${question.id}".`;
    }

    answers.push({ id: question.id, selected, ...(other ? { other } : {}) });
  }

  if (byId.size !== questions.length) {
    return 'The answers name a question that does not exist.';
  }

  return answers;
}

/** The answers as text that an agent reads: each prompt, then what was chosen. */
export function formatAgentAnswers(
  questions: AgentQuestionItem[],
  answers: AgentQuestionAnswer[],
): string {
  return questions
    .map((question) => {
      const answer = answers.find((a) => a.id === question.id);
      const parts = [
        ...(answer?.selected ?? []),
        ...(answer?.other ? [answer.other] : []),
      ];

      return `${question.prompt}\n-> ${parts.length ? parts.join(', ') : '(no answer)'}`;
    })
    .join('\n\n');
}

export class AgentQuestion {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  workspaceId: string;
  issueId: string;
  /** Null for a question that does not come from a run. */
  agentRunId: string | null;
  agentSessionId: string | null;
  /** The id that the guest gave the question. Unique per run. */
  externalId: string;
  source: AgentQuestionSource;

  questions: AgentQuestionItem[];
  status: AgentQuestionStatus;
  answers: AgentQuestionAnswer[] | null;
  answeredById: string | null;
  answeredAt: Date | null;
  /** After this time the question is EXPIRED and the agent goes on alone. */
  expiresAt: Date;
  /** When the answer reached the agent's machine. Null until it does. */
  deliveredAt: Date | null;
  /** The person who started the run. The question shows in their Needs you. */
  assigneeId: string;
}
