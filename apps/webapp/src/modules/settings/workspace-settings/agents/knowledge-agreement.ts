import {
  KnowledgeTriageDecisionEnum,
  type KnowledgeAgreementReport,
  type KnowledgeTypeAgreement,
} from '@vantikhq/types';

export interface AgreementRow {
  decision: KnowledgeTriageDecisionEnum;
  label: string;
  kappa: string;
  verdicts: string;
  cells: string;
  state: string;
  /** True when a person decides these instead of triage. */
  heldBack: boolean;
}

const LABELS: Record<string, string> = {
  [KnowledgeTriageDecisionEnum.AUTO_ACCEPT]: 'Putting facts into use',
  [KnowledgeTriageDecisionEnum.CORROBORATE]: 'Folding in repeats',
  [KnowledgeTriageDecisionEnum.REJECT]: 'Refusing on a policy',
  [KnowledgeTriageDecisionEnum.ESCALATE]: 'Sending to a person',
};

/**
 * One row per kind of decision, kappa beside the verdicts about it and how
 * they fell, so a figure off three verdicts cannot pass for one off three
 * hundred. Sending to a person is measured too, for whether what triage
 * sent people needed them, though it never backs off.
 */
export function agreementRows(
  report: KnowledgeAgreementReport,
): AgreementRow[] {
  return report.types.map((type: KnowledgeTypeAgreement) => ({
    decision: type.decision,
    label: LABELS[type.decision] ?? type.decision,
    kappa: kappaOf(type),
    verdicts:
      type.decision !== KnowledgeTriageDecisionEnum.ESCALATE &&
      type.samples < report.kappaMinSamples
        ? `${type.samples} of the ${report.kappaMinSamples} needed`
        : String(type.samples),
    cells:
      `both ${type.counts.both} · triage only ${type.counts.triageOnly} · ` +
      `person only ${type.counts.personOnly} · neither ${type.counts.neither}`,
    state: stateOf(type, report),
    heldBack: type.backedOff,
  }));
}

/** What the table measures and what it does with it, in the report's own settings. */
export function agreementNote(report: KnowledgeAgreementReport): string {
  if (report.autoTriage === 'off') {
    return 'Triage is off, so it decides nothing and there is nothing to measure.';
  }

  const floor = report.kappaFloor.toFixed(2);
  const measure =
    `Over the last ${report.windowDays} days, each verdict a person gave on ` +
    'something triage decided is set against what triage did. ' +
    `Below a kappa of ${floor} on at least ${report.kappaMinSamples} verdicts about it, ` +
    'that kind of decision goes to a person instead until it recovers.';

  return report.autoTriage === 'shadow'
    ? 'Triage is in shadow: it records what it would do and a person decides ' +
        `everything, which measures it before it acts. ${measure}`
    : `${Math.round(report.auditRate * 100)}% of what triage does alone is ` +
        `drawn for a person to check, and counted for all it stands for. ${measure}`;
}

function kappaOf(type: KnowledgeTypeAgreement): string {
  if (type.samples === 0) {
    return '—';
  }

  // With verdicts about the type, undefined only when both said it on every
  // one, which is agreement throughout; back-off reads it that way too.
  return type.kappa === null ? 'all alike' : type.kappa.toFixed(2);
}

function stateOf(
  type: KnowledgeTypeAgreement,
  report: KnowledgeAgreementReport,
): string {
  if (type.decision === KnowledgeTriageDecisionEnum.ESCALATE) {
    return 'Always a person';
  }

  if (type.backedOff) {
    return type.changedAt
      ? `A person decides, since ${new Date(type.changedAt).toLocaleDateString()}`
      : 'A person decides';
  }

  if (report.autoTriage !== 'on') {
    return 'Not acting while triage is in shadow';
  }

  return type.samples < report.kappaMinSamples
    ? 'Acting; too few verdicts to judge it yet'
    : 'Acting';
}
