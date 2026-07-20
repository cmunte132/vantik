import { validate } from 'class-validator';

import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_VECTOR_DISTANCE,
  MAX_SEARCH_LIMIT,
  SearchInputData,
  parseSearchLimit,
  parseStateCategories,
  parseVectorDistance,
} from './search.interface';

describe('SearchInputData', () => {
  it('rejects an empty query with a validation error', async () => {
    const input = Object.assign(new SearchInputData(), { query: '' });
    const errors = await validate(input);
    expect(errors.some((e) => e.property === 'query')).toBe(true);
  });

  it('accepts a non-empty query', async () => {
    const input = Object.assign(new SearchInputData(), { query: 'pg pool' });
    const errors = await validate(input);
    expect(errors.filter((e) => e.property === 'query')).toHaveLength(0);
  });
});

describe('parseSearchLimit', () => {
  // `limit` is optional, and parseInt(undefined) is NaN. A NaN reaching the
  // typesense query turned an otherwise valid search into a 500, so callers
  // that omitted the param could not search at all.
  it('falls back to the default when the param is absent or unusable', () => {
    expect(parseSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(parseSearchLimit('')).toBe(DEFAULT_SEARCH_LIMIT);
    expect(parseSearchLimit('all')).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it('clamps to a range typesense will accept', () => {
    expect(parseSearchLimit('5')).toBe(5);
    expect(parseSearchLimit('0')).toBe(1);
    expect(parseSearchLimit('-3')).toBe(1);
    expect(parseSearchLimit('100000')).toBe(MAX_SEARCH_LIMIT);
  });
});

describe('parseVectorDistance', () => {
  it('falls back to the default when the param is absent or unusable', () => {
    expect(parseVectorDistance(undefined)).toBe(DEFAULT_VECTOR_DISTANCE);
    expect(parseVectorDistance('close enough')).toBe(DEFAULT_VECTOR_DISTANCE);
  });

  it('keeps a supplied threshold within the cosine distance range', () => {
    expect(parseVectorDistance('0.5')).toBe(0.5);
    expect(parseVectorDistance('-1')).toBe(0);
    expect(parseVectorDistance('9')).toBe(2);
  });
});

describe('parseStateCategories', () => {
  it('normalises a comma separated list', () => {
    expect(parseStateCategories(' completed , started ')).toEqual([
      'COMPLETED',
      'STARTED',
    ]);
  });

  it('returns an empty list when unset', () => {
    expect(parseStateCategories(undefined)).toEqual([]);
    expect(parseStateCategories('')).toEqual([]);
  });
});
