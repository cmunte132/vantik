import { describe, expect, it } from 'vitest';

import {
  continuedFrom,
  sessionRoute,
  sessionTitle,
} from './session-vocabulary';

const hosted = {
  id: 'abcdef-1',
  harness: 'pi',
  location: 'HOSTED',
  channel: 'HOSTED',
  driver: 'VANTIK',
};

describe('how a session is described', () => {
  it('says the harness and where it runs, then the channel and who drives', () => {
    const hooks = {
      id: 's2',
      harness: 'claude-code',
      location: 'LOCAL',
      channel: 'HOOKS',
      driver: 'TERMINAL',
    };

    expect(sessionTitle(hooks)).toBe('Claude Code · Local');
    expect(sessionRoute(hooks)).toBe('Hooks · Terminal');
    expect(sessionTitle(hosted)).toBe('Pi · Hosted');
    expect(sessionRoute(hosted)).toBe('Hosted run · Vantik');
  });

  it('shows a harness or channel this bundle does not know as it arrives', () => {
    expect(
      sessionTitle({
        id: 's3',
        harness: 'aider',
        location: 'LOCAL',
        channel: 'MAIL',
      }),
    ).toBe('aider · Local');
    expect(
      sessionRoute({
        id: 's3',
        location: 'LOCAL',
        channel: 'MAIL',
        driver: null,
      }),
    ).toBe('MAIL');
    expect(
      sessionTitle({ id: 's4', location: 'UNKNOWN', channel: 'HOOKS' }),
    ).toBe('Unknown harness · Unknown location');
  });

  it('names the parent of a session that forked from another', () => {
    expect(continuedFrom({ parentSessionId: null })).toBeNull();
    expect(continuedFrom({ parentSessionId: 'abcdef-1' }, hosted)).toBe(
      'continued from Pi · abcdef',
    );
    // The parent may be on an issue this client does not hold.
    expect(continuedFrom({ parentSessionId: 'zzzzzz-9' })).toBe(
      'continued from zzzzzz',
    );
  });
});
