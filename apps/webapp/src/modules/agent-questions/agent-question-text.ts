import type { AgentQuestionAnswer, AgentQuestionItem } from '@vantikhq/types';

/** How long until a time, short: "24 min", "3 h". Empty once it has passed. */
export function timeLeft(expiresAt: string, now = Date.now()): string {
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60000);

  if (!(minutes > 0)) {
    return '';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)} h`;
  }

  return `${Math.round(minutes / (60 * 24))} d`;
}

/** What the agent does when nobody answers, with the time left. */
export function waitLine(expiresAt: string, now = Date.now()): string {
  const left = timeLeft(expiresAt, now);

  return left
    ? `Proceeds on its own judgement in ${left}`
    : 'Proceeds on its own judgement now';
}

/** The state of a question that is not open, in one line. */
export function closedLine(status: string): string {
  switch (status) {
    case 'EXPIRED':
      return 'Expired: the agent continued on its own judgement';
    case 'CANCELLED':
      return 'Cancelled: the run ended before anyone answered';
    default:
      return 'Answered';
  }
}

/** Where the run is, as a person would say it. */
export function placeOf(
  executor: string | undefined,
  harness: string | null | undefined,
): string {
  const where = executor === 'local' ? 'your machine' : 'a hosted sandbox';

  return harness ? `${harness} on ${where}` : where;
}

/** What a person chose for one question, as text. */
export function chosenText(answer: AgentQuestionAnswer | undefined): string {
  if (!answer) {
    return 'No answer';
  }

  const parts = [...answer.selected];

  if (answer.other?.trim()) {
    parts.push(answer.other.trim());
  }

  return parts.length > 0 ? parts.join(', ') : 'No answer';
}

export interface QuestionDraft {
  selected: string[];
  other: string;
}

/** Whether a question has options to pick from. */
export function hasOptions(question: AgentQuestionItem): boolean {
  return Boolean(question.options && question.options.length > 0);
}

/** A question with no options takes text only; one with options may add text. */
export function acceptsOther(question: AgentQuestionItem): boolean {
  return !hasOptions(question) || Boolean(question.allowOther);
}

/** Whether every question has an answer in the draft. */
export function isComplete(
  questions: AgentQuestionItem[],
  drafts: Record<string, QuestionDraft | undefined>,
): boolean {
  return questions.every((question) => {
    const draft = drafts[question.id];

    return Boolean(
      draft && (draft.selected.length > 0 || draft.other.trim().length > 0),
    );
  });
}

/** The body of the answer request. */
export function toAnswers(
  questions: AgentQuestionItem[],
  drafts: Record<string, QuestionDraft | undefined>,
): AgentQuestionAnswer[] {
  return questions.map((question) => {
    const draft = drafts[question.id] ?? { selected: [], other: '' };
    const other = draft.other.trim();

    return {
      id: question.id,
      selected: draft.selected,
      ...(other && acceptsOther(question) ? { other } : {}),
    };
  });
}
