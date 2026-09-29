import type { TrustTone } from './trust';

import {
  KnowledgeInboxChoiceEnum,
  KnowledgeInboxKindEnum,
  KnowledgeReviewReasonEnum,
  KnowledgeTriageDecisionEnum,
  type KnowledgeInboxEvent,
  type KnowledgeInboxItem,
} from '@vantikhq/types';

import { auditPrompt, REASON_LABELS } from './review-reasons';

/** The label of each kind in the list, and its colour. */
export const KIND_LABELS: Record<
  KnowledgeInboxKindEnum,
  { label: string; tone?: TrustTone }
> = {
  [KnowledgeInboxKindEnum.CONTRADICTION]: {
    label: 'Contradiction',
    tone: 'needYou',
  },
  [KnowledgeInboxKindEnum.RULE]: { label: 'Team rule', tone: 'needYou' },
  [KnowledgeInboxKindEnum.FACT]: { label: 'New fact', tone: 'needYou' },
  [KnowledgeInboxKindEnum.AUDIT]: { label: 'Audit' },
  [KnowledgeInboxKindEnum.ARCHIVE]: { label: 'Retire?', tone: 'needYou' },
  [KnowledgeInboxKindEnum.REWRITE]: { label: 'Page rewrite', tone: 'people' },
  [KnowledgeInboxKindEnum.GAP]: { label: 'Knowledge gap' },
};

const AUDIT_VERB: Partial<Record<KnowledgeTriageDecisionEnum, string>> = {
  [KnowledgeTriageDecisionEnum.AUTO_ACCEPT]: 'accept',
  [KnowledgeTriageDecisionEnum.CORROBORATE]: 'fold in',
  [KnowledgeTriageDecisionEnum.REJECT]: 'refuse',
};

/** An item as a question a person answers. */
export function inboxTitle(item: KnowledgeInboxItem): string {
  const content = item.entry?.content.trim() ?? '';

  switch (item.kind) {
    case KnowledgeInboxKindEnum.RULE:
      return `Is “${content}” the rule?`;
    case KnowledgeInboxKindEnum.AUDIT:
      return `Was it right to ${
        (item.decision && AUDIT_VERB[item.decision.decision]) ?? 'settle'
      } “${content}”?`;
    case KnowledgeInboxKindEnum.ARCHIVE:
      return `Stop using “${content}”?`;
    case KnowledgeInboxKindEnum.REWRITE:
      return `Accept the rewrite of ${item.pageTitle ?? 'a page'}?`;
    case KnowledgeInboxKindEnum.GAP: {
      const query = item.gap?.query.trim() ?? '';

      return query.endsWith('?') ? query : `${query}?`;
    }
    default:
      return content;
  }
}

/** The quiet line under an open item in the list. */
export function inboxSubline(item: KnowledgeInboxItem): string {
  switch (item.kind) {
    case KnowledgeInboxKindEnum.GAP:
      return `asked by ${item.gap?.count ?? 0} runs`;
    case KnowledgeInboxKindEnum.AUDIT:
      return 'settled by agents';
    case KnowledgeInboxKindEnum.REWRITE:
      return item.proposal?.summary ?? '';
    default:
      return item.pageTitle ?? 'Outside any page';
  }
}

/** Why the item is in front of a person, as the pill above its title says it. */
export function inboxReason(item: KnowledgeInboxItem): string {
  switch (item.kind) {
    case KnowledgeInboxKindEnum.CONTRADICTION:
      return item.reasons.includes(
        KnowledgeReviewReasonEnum.CONTRADICTS_VERIFIED,
      )
        ? 'Contradicts a fact a person confirmed'
        : item.reasons.includes(KnowledgeReviewReasonEnum.CONTRADICTS_LOCKED)
          ? 'Contradicts a page kept by hand'
          : 'The code now disagrees with it';
    case KnowledgeInboxKindEnum.AUDIT:
      return 'Settled by agents, drawn for a check';
    case KnowledgeInboxKindEnum.REWRITE:
      return 'The gardener proposes a rewrite';
    case KnowledgeInboxKindEnum.GAP:
      return `Asked by ${item.gap?.count ?? 0} runs, answered by nothing`;
    default:
      return item.reasons[0]
        ? REASON_LABELS[item.reasons[0]]
        : 'Waits on a person';
  }
}

/** What the item asks, in a sentence or two under its title. */
export function inboxExplanation(item: KnowledgeInboxItem): string {
  switch (item.kind) {
    case KnowledgeInboxKindEnum.CONTRADICTION:
      return 'An agent wrote the fact on the right. It contradicts the fact on the left, which agents are given now. Both cannot be served.';
    case KnowledgeInboxKindEnum.RULE:
      return 'An agent wrote this down as a rule of the team. No agent follows it until a person decides.';
    case KnowledgeInboxKindEnum.FACT:
      return 'An agent wrote this as it worked. No agent is given it until a person decides.';
    case KnowledgeInboxKindEnum.AUDIT:
      return item.decision
        ? auditPrompt({ decisionId: item.decision.id, ...item.decision })
            .question
        : 'Triage acted on this without a person.';
    case KnowledgeInboxKindEnum.ARCHIVE:
      return `${item.proposal?.summary ?? 'The gardener found it no longer holds.'} Agents are given it until a person decides.`;
    case KnowledgeInboxKindEnum.REWRITE:
      return `${item.proposal?.summary ?? 'The gardener folded facts into a new body'}. The page does not change until a person accepts.`;
    case KnowledgeInboxKindEnum.GAP:
      return 'Agents asked this and the pages had no answer. Write the fact that answers it, and agents are given it from then on.';
  }
}

export interface InboxChoice {
  choice: KnowledgeInboxChoiceEnum;
  label: string;
}

/** The two answers an item takes, the first the one most likely right. None for a gap. */
export function inboxChoices(item: KnowledgeInboxItem): InboxChoice[] {
  switch (item.kind) {
    case KnowledgeInboxKindEnum.CONTRADICTION:
      return [
        {
          choice: KnowledgeInboxChoiceEnum.USE_NEW,
          label: 'The new fact is right · retire the old one',
        },
        {
          choice: KnowledgeInboxChoiceEnum.KEEP_OLD,
          label: 'The old fact holds · set the new one aside',
        },
      ];
    case KnowledgeInboxKindEnum.RULE:
      return [
        { choice: KnowledgeInboxChoiceEnum.USE, label: 'Make it the rule' },
        { choice: KnowledgeInboxChoiceEnum.SET_ASIDE, label: 'Set it aside' },
      ];
    case KnowledgeInboxKindEnum.FACT:
      return [
        { choice: KnowledgeInboxChoiceEnum.USE, label: 'Use it' },
        { choice: KnowledgeInboxChoiceEnum.SET_ASIDE, label: 'Set it aside' },
      ];
    case KnowledgeInboxKindEnum.AUDIT: {
      const prompt = item.decision
        ? auditPrompt({ decisionId: item.decision.id, ...item.decision })
        : { agree: 'Triage was right', disagree: 'Undo it' };

      return [
        { choice: KnowledgeInboxChoiceEnum.AGREE, label: prompt.agree },
        { choice: KnowledgeInboxChoiceEnum.UNDO, label: prompt.disagree },
      ];
    }
    case KnowledgeInboxKindEnum.ARCHIVE:
      return [
        { choice: KnowledgeInboxChoiceEnum.RETIRE, label: 'Retire it' },
        { choice: KnowledgeInboxChoiceEnum.KEEP, label: 'Keep it in use' },
      ];
    case KnowledgeInboxKindEnum.REWRITE:
      return [
        {
          choice: KnowledgeInboxChoiceEnum.ACCEPT,
          label: 'Accept the rewrite',
        },
        {
          choice: KnowledgeInboxChoiceEnum.DECLINE,
          label: 'Keep the page as it is',
        },
      ];
    case KnowledgeInboxKindEnum.GAP:
      return [];
  }
}

/** What happened to a done item, said with who did it. */
export function doneLine(
  item: KnowledgeInboxItem,
  nameOf: (userId: string | null) => string | null,
): string {
  if (!item.doneById) {
    return capitalize(item.resolution ?? 'Settled');
  }

  return `${nameOf(item.doneById) ?? 'Someone'} ${item.resolution ?? 'decided'}`;
}

/** One line of the activity thread, apart from a comment's text. */
export function eventLine(
  event: KnowledgeInboxEvent,
  nameOf: (userId: string | null) => string | null,
): string {
  switch (event.type) {
    case 'ASSIGNED':
      return event.assigneeId
        ? event.assigneeId === event.userId
          ? 'took it'
          : `assigned it to ${nameOf(event.assigneeId) ?? 'someone'}`
        : 'took everyone off it';
    case 'DECIDED':
      return event.body ?? 'decided';
    case 'SETTLED':
      return capitalize(event.body ?? 'settled');
    default:
      return '';
  }
}

/** Whether a time falls on today, where the reader is. */
export function isToday(at: string | Date | null, now = new Date()) {
  if (!at) {
    return false;
  }

  const day = new Date(at);

  return (
    day.getFullYear() === now.getFullYear() &&
    day.getMonth() === now.getMonth() &&
    day.getDate() === now.getDate()
  );
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
