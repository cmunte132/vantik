import {
  KnowledgeTriageDecisionEnum,
  type KnowledgeAgreementReport,
  type KnowledgeTypeAgreement,
} from '@vantikhq/types';
import { describe, expect, it } from 'vitest';

import { agreementNote, agreementRows } from './knowledge-agreement';

/**
 * The agreement panel's figures. Like the holdout panel, it must never show a
 * kappa without the verdicts it rests on.
 */

function type(
  overrides: Partial<KnowledgeTypeAgreement> = {},
): KnowledgeTypeAgreement {
  return {
    decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
    kappa: 0.7234,
    samples: 34,
    observed: 0.88,
    expected: 0.57,
    counts: { both: 20, triageOnly: 3, personOnly: 2, neither: 9 },
    weighted: { both: 200, triageOnly: 30, personOnly: 2, neither: 9 },
    backedOff: false,
    changedAt: null,
    ...overrides,
  };
}

function report(
  types: KnowledgeTypeAgreement[],
  overrides: Partial<KnowledgeAgreementReport> = {},
): KnowledgeAgreementReport {
  return {
    autoTriage: 'on',
    windowDays: 30,
    since: '2026-08-28T00:00:00.000Z',
    kappaFloor: 0.6,
    kappaMinSamples: 20,
    auditRate: 0.1,
    types,
    ...overrides,
  };
}

describe('the agreement panel', () => {
  it('[KG-5.3] shows kappa per decision type beside its verdicts and how they fell', () => {
    const [row] = agreementRows(report([type()]));

    expect(row).toEqual({
      decision: 'AUTO_ACCEPT',
      label: 'Putting facts into use',
      kappa: '0.72',
      verdicts: '34',
      cells: 'both 20 · triage only 3 · person only 2 · neither 9',
      state: 'Acting',
      heldBack: false,
    });
  });

  it('[KG-5.3] says how far a type is from enough verdicts to judge it', () => {
    const [row] = agreementRows(
      report([
        type({
          decision: KnowledgeTriageDecisionEnum.CORROBORATE,
          kappa: 0.1,
          samples: 3,
        }),
      ]),
    );

    expect(row.label).toBe('Folding in repeats');
    expect(row.verdicts).toBe('3 of the 20 needed');
    expect(row.state).toBe('Acting; too few verdicts to judge it yet');
  });

  it('[KG-5.3] tells no verdicts apart from verdicts that were all alike', () => {
    const [none, alike] = agreementRows(
      report([
        type({ kappa: null, samples: 0 }),
        type({
          decision: KnowledgeTriageDecisionEnum.REJECT,
          kappa: null,
          samples: 25,
        }),
      ]),
    );

    expect(none.kappa).toBe('—');
    expect(alike.kappa).toBe('all alike');
    expect(alike.label).toBe('Refusing on a policy');
  });

  it('[KG-5.4] shows a backed-off type as decided by a person', () => {
    const [row] = agreementRows(
      report([
        type({
          kappa: 0.31,
          backedOff: true,
          changedAt: '2026-09-25T09:00:00.000Z',
        }),
      ]),
    );

    expect(row.heldBack).toBe(true);
    expect(row.state).toMatch(/^A person decides, since /);
  });

  it('[KG-5.3] states the window, floor and audit rate it measures by', () => {
    const on = agreementNote(report([]));

    expect(on).toContain('last 30 days');
    expect(on).toContain('kappa of 0.60');
    expect(on).toContain('at least 20 verdicts');
    expect(on).toContain('10% of what triage does alone');
    expect(agreementNote(report([], { autoTriage: 'shadow' }))).toMatch(
      /^Triage is in shadow/,
    );
    expect(agreementNote(report([], { autoTriage: 'off' }))).toMatch(
      /^Triage is off/,
    );
    expect(
      agreementRows(report([type()], { autoTriage: 'shadow' }))[0].state,
    ).toBe('Not acting while triage is in shadow');
  });
});
