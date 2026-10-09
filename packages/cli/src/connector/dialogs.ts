/**
 * Maps the dialogs that omp opens in RPC mode to questions for a person, and
 * the answer of the person back to the reply that omp expects.
 *
 * omp sends `extension_ui_request` with a `method`. The dialog methods
 * (`select`, `confirm`, `input`, `editor`) wait for a person, so they become
 * questions on the server. The other methods only show something (`notify`,
 * `setStatus`, `setWidget`, `setTitle`), need no reply, and are ignored.
 */
import {
  AGENT_QUESTION_LIMITS,
  type AgentQuestionItem,
  type ConnectorRunAnswer,
} from '@vantikhq/types';

/** The fields of an `extension_ui_request` that the connector reads. */
export interface OmpUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: unknown;
  message?: unknown;
  options?: unknown;
  optionDetails?: unknown;
  placeholder?: unknown;
}

export type DialogMethod = 'select' | 'confirm' | 'input' | 'editor';

const DIALOG_METHODS: readonly string[] = [
  'select',
  'confirm',
  'input',
  'editor',
];

/** A dialog that waits for a reply, with what is needed to make the reply. */
export interface PendingDialog {
  /** The id of the dialog in omp. The reply names it. */
  requestId: string;
  method: DialogMethod;
  /** The option labels of a `select`, to match a typed answer against. */
  options: string[];
}

export interface DialogQuestion {
  /** The id of the question on the server. A plain token. */
  questionId: string;
  items: AgentQuestionItem[];
  dialog: PendingDialog;
}

const YES = 'Yes';
const NO = 'No';

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** The id a question gets on the server, from the id of the dialog. */
export function questionIdOf(requestId: string): string {
  return `omp-${requestId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56)}`;
}

/** The question for a dialog, or null for a method that waits for nobody. */
export function dialogToQuestion(request: OmpUiRequest): DialogQuestion | null {
  if (
    !DIALOG_METHODS.includes(request.method) ||
    typeof request.id !== 'string' ||
    !request.id
  ) {
    return null;
  }

  const method = request.method as DialogMethod;
  const title = text(request.title);
  const message = text(request.message);
  const rawOptions = Array.isArray(request.options)
    ? request.options.filter((o): o is string => typeof o === 'string')
    : [];
  const details = Array.isArray(request.optionDetails)
    ? (request.optionDetails as Array<{ description?: unknown } | null>)
    : [];

  const item: AgentQuestionItem = {
    id: 'dialog',
    prompt: '',
  };
  let options: string[] = [];

  if (method === 'confirm') {
    item.options = [{ label: YES }, { label: NO }];
  } else if (method === 'select') {
    const fits =
      rawOptions.length > 0 &&
      rawOptions.length <= AGENT_QUESTION_LIMITS.options &&
      rawOptions.every(
        (label) =>
          label.trim() &&
          label.length <= AGENT_QUESTION_LIMITS.label &&
          new Set(rawOptions).size === rawOptions.length,
      );

    options = rawOptions;

    if (fits) {
      item.options = rawOptions.map((label, index) => {
        const description = text(details[index]?.description);
        return {
          label,
          ...(description
            ? { description: description.slice(0, AGENT_QUESTION_LIMITS.description) }
            : {}),
        };
      });
    } else {
      // Too many choices to show as options. A person types the one they want.
      item.allowOther = true;
    }
  }

  const listed =
    method === 'select' && !item.options && rawOptions.length > 0
      ? `\nChoices: ${rawOptions.join(' | ')}`
      : '';
  const hint = method === 'input' ? text(request.placeholder) : '';

  item.prompt = [title, message, hint ? `(${hint})` : '']
    .filter(Boolean)
    .join('\n')
    .concat(listed)
    .slice(0, AGENT_QUESTION_LIMITS.prompt);

  if (!item.prompt) {
    item.prompt = 'omp asks for your input.';
  }

  return {
    questionId: questionIdOf(request.id),
    items: [item],
    dialog: { requestId: request.id, method, options },
  };
}

/**
 * The body of the `extension_ui_response` for a dialog, without its `type`
 * and `id`. Nobody answered, so the dialog is cancelled, and a timeout says
 * so. omp then resolves the dialog to its default.
 */
export function dialogResponse(
  dialog: PendingDialog,
  answer: Pick<ConnectorRunAnswer, 'status' | 'answers'>,
): Record<string, unknown> {
  if (answer.status !== 'answered') {
    return { cancelled: true, timedOut: answer.status === 'expired' };
  }

  const first = answer.answers[0];
  const picked = first?.selected[0];
  const typed = first?.other?.trim();

  if (dialog.method === 'confirm') {
    return { confirmed: picked === YES };
  }

  if (dialog.method === 'select') {
    const label =
      picked ??
      dialog.options.find(
        (option) => option.toLowerCase() === (typed ?? '').toLowerCase(),
      );

    // A reply that is not one of the options would fail inside omp.
    return label === undefined ? { cancelled: true } : { value: label };
  }

  return { value: typed ?? picked ?? '' };
}
