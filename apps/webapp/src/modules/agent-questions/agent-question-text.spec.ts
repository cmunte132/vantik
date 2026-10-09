import { describe, expect, it } from 'vitest';

import {
  chosenText,
  closedLine,
  isComplete,
  placeOf,
  timeLeft,
  toAnswers,
  waitLine,
} from './agent-question-text';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('timeLeft', () => {
  it('says minutes, then hours, then days', () => {
    expect(timeLeft(at(24 * 60000), NOW)).toBe('24 min');
    expect(timeLeft(at(3 * 3600000), NOW)).toBe('3 h');
    expect(timeLeft(at(2 * 86400000), NOW)).toBe('2 d');
  });

  it('is empty once the time has passed', () => {
    expect(timeLeft(at(-1000), NOW)).toBe('');
    expect(waitLine(at(-1000), NOW)).toBe('Proceeds on its own judgement now');
  });

  it('names the wait', () => {
    expect(waitLine(at(24 * 60000), NOW)).toBe(
      'Proceeds on its own judgement in 24 min',
    );
  });
});

describe('closedLine and placeOf', () => {
  it('says what an expired question means', () => {
    expect(closedLine('EXPIRED')).toBe(
      'Expired: the agent continued on its own judgement',
    );
  });

  it('names the harness and the place', () => {
    expect(placeOf('local', 'omp')).toBe('omp on your machine');
    expect(placeOf('hosted', 'pi')).toBe('pi on a hosted sandbox');
    expect(placeOf('hosted', null)).toBe('a hosted sandbox');
  });
});

describe('answers', () => {
  const questions = [
    { id: 'a', prompt: 'Which?', options: [{ label: 'X' }, { label: 'Y' }] },
    { id: 'b', prompt: 'Why?' },
    {
      id: 'c',
      prompt: 'More?',
      options: [{ label: 'P' }],
      allowOther: true,
      multiple: true,
    },
  ];

  it('needs every question answered', () => {
    expect(
      isComplete(questions, {
        a: { selected: ['X'], other: '' },
        b: { selected: [], other: '  ' },
        c: { selected: ['P'], other: '' },
      }),
    ).toBe(false);
    expect(
      isComplete(questions, {
        a: { selected: ['X'], other: '' },
        b: { selected: [], other: 'Because' },
        c: { selected: [], other: 'Z' },
      }),
    ).toBe(true);
  });

  it('keeps text only where the question takes it', () => {
    expect(
      toAnswers(questions, {
        a: { selected: ['X'], other: 'ignored' },
        b: { selected: [], other: ' Because ' },
        c: { selected: ['P'], other: 'Z' },
      }),
    ).toEqual([
      { id: 'a', selected: ['X'] },
      { id: 'b', selected: [], other: 'Because' },
      { id: 'c', selected: ['P'], other: 'Z' },
    ]);
  });

  it('reads an answer back as text', () => {
    expect(chosenText({ id: 'a', selected: ['X'], other: 'and Z' })).toBe(
      'X, and Z',
    );
    expect(chosenText(undefined)).toBe('No answer');
  });
});
