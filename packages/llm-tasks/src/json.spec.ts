import { parseObject } from './json';

describe('parseObject', () => {
  it('reads the object from the first { to the last }', () => {
    expect(parseObject('Here: {"a": {"b": 1}} done')).toEqual({ a: { b: 1 } });
  });

  it('reads an object in a code fence', () => {
    expect(parseObject('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it('returns null if there is no object', () => {
    expect(parseObject(null)).toBeNull();
    expect(parseObject('no braces')).toBeNull();
    expect(parseObject('} before {')).toBeNull();
  });

  it('returns null for text that is not JSON', () => {
    expect(parseObject('{ not json }')).toBeNull();
  });

  it('is fast on a long answer with many open braces', () => {
    const started = Date.now();

    expect(parseObject('{'.repeat(200_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
