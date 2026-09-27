import type {
  KnowledgeArmComparison,
  KnowledgeArmStats,
} from '@vantikhq/types';

import { describe, expect, it } from 'vitest';

import { armRows, FEW_RUNS, sampleWarning } from './knowledge-arms';

/**
 * The holdout panel's figures. What it must never do is show a rate without
 * what it was measured over: 100% off two runs reads as a result.
 */

function arm(overrides: Partial<KnowledgeArmStats> = {}): KnowledgeArmStats {
  return {
    arm: 'TREATMENT',
    runs: 40,
    verification: { count: 30, of: 40, rate: 0.75 },
    reviewPasses: { mean: 1.84, runs: 38 },
    costUsd: { mean: 0.456, runs: 40 },
    merged: { count: 12, of: 16, rate: 0.75 },
    openPullRequests: 0,
    ...overrides,
  } as KnowledgeArmStats;
}

function comparison(arms: KnowledgeArmStats[]): KnowledgeArmComparison {
  return { holdoutRate: 0.1, since: null, arms } as KnowledgeArmComparison;
}

describe('the holdout panel', () => {
  it('[KG-3.6] shows every figure beside what it was measured over', () => {
    const [row] = armRows(comparison([arm()]));

    expect(row).toEqual({
      label: 'Given knowledge',
      runs: '40',
      verification: '75% (30 of 40)',
      reviewPasses: '1.8 (38 runs)',
      cost: '$0.46 (40 runs)',
      merged: '75% (12 of 16)',
    });
  });

  it('[KG-3.6] names the held-out arm, and counts its open pull requests apart', () => {
    const [row] = armRows(
      comparison([
        arm({
          arm: 'HOLDOUT',
          merged: { count: 1, of: 3, rate: 1 / 3 },
          openPullRequests: 2,
        } as Partial<KnowledgeArmStats>),
      ]),
    );

    expect(row.label).toBe('Held out');
    expect(row.merged).toBe('33% (1 of 3) · 2 open');
  });

  it('[KG-3.6] shows a dash, not nought, for a measure with nothing to measure', () => {
    const [row] = armRows(
      comparison([
        arm({
          runs: 0,
          verification: { count: 0, of: 0, rate: null },
          reviewPasses: { mean: null, runs: 0 },
          costUsd: { mean: null, runs: 0 },
          merged: { count: 0, of: 0, rate: null },
        }),
      ]),
    );

    expect(row).toMatchObject({
      runs: '0',
      verification: '—',
      reviewPasses: '—',
      cost: '—',
      merged: '—',
    });
  });

  it('[KG-3.6] warns while the smaller arm is too small to compare', () => {
    expect(
      sampleWarning(
        comparison([
          arm({ runs: 200 }),
          arm({ arm: 'HOLDOUT', runs: 12 } as Partial<KnowledgeArmStats>),
        ]),
      ),
    ).toContain('The smaller arm has 12 finished runs.');
    expect(
      sampleWarning(comparison([arm({ runs: 200 }), arm({ runs: 1 })])),
    ).toContain('has 1 finished run.');
    expect(
      sampleWarning(comparison([arm({ runs: 200 }), arm({ runs: 0 })])),
    ).toMatch(/nothing to compare/);
    expect(sampleWarning(comparison([]))).toMatch(/nothing to compare/);
  });

  it('[KG-3.6] says nothing more once both arms have enough runs', () => {
    expect(
      sampleWarning(comparison([arm({ runs: 500 }), arm({ runs: FEW_RUNS })])),
    ).toBeNull();
    expect(
      sampleWarning(
        comparison([arm({ runs: 500 }), arm({ runs: FEW_RUNS - 1 })]),
      ),
    ).not.toBeNull();
  });
});
