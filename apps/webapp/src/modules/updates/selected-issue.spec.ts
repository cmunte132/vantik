import { describe, expect, it } from 'vitest';

import { dividerHidden, teamIdentifierOf } from './selected-issue';

describe('teamIdentifierOf', () => {
  it('reads the team out of an issue parameter', () => {
    expect(teamIdentifierOf('ENG-89')).toBe('ENG');
    expect(teamIdentifierOf('SUP-89')).toBe('SUP');
  });

  it('reads the first value when the router gives an array', () => {
    expect(teamIdentifierOf(['ENG-89'])).toBe('ENG');
  });

  it('has no answer when there is no issue in the route', () => {
    expect(teamIdentifierOf(undefined)).toBeUndefined();
    expect(teamIdentifierOf([])).toBeUndefined();
  });

  // Answering with the identifier alone would go on to match the first issue
  // of that team, which is not the issue the route names.
  it('has no answer for an identifier with no number', () => {
    expect(teamIdentifierOf('ENG')).toBeUndefined();
    expect(teamIdentifierOf('ENG-')).toBeUndefined();
    expect(teamIdentifierOf('')).toBeUndefined();
  });
});

describe('dividerHidden', () => {
  const ENG_89 = 'issue-eng-89';
  const SUP_89 = 'issue-sup-89';
  const OTHER = 'issue-other';

  it('hides the divider on the open row', () => {
    expect(dividerHidden(ENG_89, OTHER, ENG_89)).toBe(true);
  });

  it('hides the divider on the row above the open one', () => {
    expect(dividerHidden(OTHER, ENG_89, ENG_89)).toBe(true);
  });

  it('keeps the divider between two rows that are not open', () => {
    expect(dividerHidden(OTHER, SUP_89, ENG_89)).toBe(false);
  });

  /**
   * The bug this replaced. ENG-89 and SUP-89 are different issues that share a
   * number, and the row compared them by an identifier it rebuilt from its own
   * team, so opening one of them changed how the other was drawn.
   */
  it('tells apart two teams that share an issue number', () => {
    expect(dividerHidden(SUP_89, OTHER, ENG_89)).toBe(false);
    expect(dividerHidden(OTHER, SUP_89, ENG_89)).toBe(false);
  });

  it('keeps every divider when no issue is open', () => {
    expect(dividerHidden(ENG_89, SUP_89, undefined)).toBe(false);
  });
});
