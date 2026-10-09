import { describe, expect, it } from 'vitest';

import {
  continuedFrom,
  drivenBy,
  resumeCommand,
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
    expect(sessionRoute(hooks)).toBe('Hooks · In your terminal');
    expect(sessionTitle(hosted)).toBe('Pi · Hosted');
    expect(sessionRoute(hosted)).toBe('Hosted run · Vantik is driving');
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

const ID = '01a11e21-8ec7-763d-b981-ef21a2f3a662';
const now = new Date('2026-10-09T10:00:00Z');

describe('who drives a session', () => {
  const terminal = {
    id: 's',
    location: 'LOCAL',
    channel: 'CONNECTOR',
    driver: 'TERMINAL',
  };

  it('says nothing for no driver, a lapsed lease, or an ended session', () => {
    expect(drivenBy({ ...terminal, driver: null }, now)).toBeNull();
    expect(
      drivenBy(
        { ...terminal, driverLeaseExpiresAt: '2026-10-09T09:59:00Z' },
        now,
      ),
    ).toBeNull();
    expect(
      drivenBy({ ...terminal, endedAt: '2026-10-09T09:00:00Z' }, now),
    ).toBeNull();
  });

  it('names the terminal and Vantik while the lease holds', () => {
    expect(
      drivenBy(
        { ...terminal, driverLeaseExpiresAt: '2026-10-09T10:00:30Z' },
        now,
      ),
    ).toBe('In your terminal');
    expect(drivenBy({ ...terminal, driver: 'VANTIK' }, now)).toBe(
      'Vantik is driving',
    );
  });
});

describe('the command that resumes an omp session', () => {
  const session = {
    id: 's',
    harness: 'omp',
    location: 'LOCAL',
    channel: 'HOOKS',
    externalId: `omp:${ID}`,
  };

  it('uses the uuid from a hooks id and from a connector id', () => {
    expect(resumeCommand(session)).toBe(`omp --resume ${ID}`);
    expect(resumeCommand({ ...session, externalId: ID })).toBe(
      `omp --resume ${ID}`,
    );
  });

  it('starts with cd to the worktree of a connector run, quoting the path', () => {
    expect(resumeCommand(session, '/Users/me/.vantik/wt/acme/ENG-1')).toBe(
      `cd /Users/me/.vantik/wt/acme/ENG-1 && omp --resume ${ID}`,
    );
    expect(resumeCommand(session, '/Users/me/My Work/wt')).toBe(
      `cd '/Users/me/My Work/wt' && omp --resume ${ID}`,
    );
  });

  it('gives nothing for another harness, a hosted run, or a run that has not started omp', () => {
    expect(resumeCommand({ ...session, harness: 'claude-code' })).toBeNull();
    expect(resumeCommand({ ...session, location: 'HOSTED' })).toBeNull();
    expect(
      resumeCommand({ ...session, externalId: ID, agentRunId: ID }),
    ).toBeNull();
  });
});
