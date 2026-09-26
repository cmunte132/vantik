import { describe, expect, it } from 'vitest';

import { errorMessage } from './mutation';

describe('errorMessage', () => {
  it('reads a Nest refusal from where the ajax client puts the body', () => {
    const rejected = {
      errors: { statusCode: 400, message: 'This cycle has already ended' },
      reqUrl: '/api/v1/cycles/1/start',
      resStatus: 400,
    };

    expect(errorMessage(rejected)).toBe('This cycle has already ended');
  });

  it('reads an axios error, whose body sits under response.data', () => {
    const rejected = {
      message: 'Request failed with status code 400',
      response: { data: { message: 'The path is not a git repository' } },
    };

    expect(errorMessage(rejected)).toBe('The path is not a git repository');
  });

  it('joins the list a validation failure sends', () => {
    const rejected = {
      errors: { message: ['name must be a string', 'teamId is required'] },
    };

    expect(errorMessage(rejected)).toBe(
      'name must be a string; teamId is required',
    );
  });

  it('keeps a plain-text body, but not an HTML error page', () => {
    expect(errorMessage({ message: 'Too many requests' })).toBe(
      'Too many requests',
    );
    expect(
      errorMessage({ message: '<!DOCTYPE html><html>502</html>' }, 'Nope'),
    ).toBe('Nope');
  });

  it('falls back when the failure carries no words at all', () => {
    expect(errorMessage({ reqUrl: '/x', timeout: true }, 'Timed out')).toBe(
      'Timed out',
    );
    expect(errorMessage(undefined)).toBe(
      'The request failed, and the server gave no reason.',
    );
  });
});
