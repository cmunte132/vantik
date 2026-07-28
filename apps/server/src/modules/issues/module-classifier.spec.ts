/**
 * The module classifier, and the memory of what a person dismissed.
 *
 * This is the least confident of the three tiers that fill in a module. It
 * never writes to `Issue.moduleIds`, so the cost of a wrong answer is a chip
 * nobody clicks. The cost of a *badly read* answer is worse: a name the model
 * invented must not become an id, and a module a person closed must not come
 * back on the next run.
 */
import {
  dismissedModuleIds,
  matchModuleNames,
  withDismissedModule,
} from './issues-ai.utils';

const MODULES = [
  { id: 'module-server', name: 'Server', description: 'The API' },
  { id: 'module-webapp', name: 'Webapp', description: 'The React app' },
  { id: 'module-docs', name: 'Docs', description: null },
];

describe('matchModuleNames', () => {
  it('turns one name into its id', () => {
    expect(matchModuleNames('Server', MODULES)).toEqual(['module-server']);
  });

  it('reads the comma-separated list the prompt asks for', () => {
    expect(matchModuleNames('Server, Webapp', MODULES)).toEqual([
      'module-server',
      'module-webapp',
    ]);
  });

  it('reads a list the model put on separate lines instead', () => {
    expect(matchModuleNames('Server\nWebapp', MODULES)).toEqual([
      'module-server',
      'module-webapp',
    ]);
  });

  it('ignores the case and the spacing the model chose', () => {
    expect(matchModuleNames('  server ,WEBAPP  ', MODULES)).toEqual([
      'module-server',
      'module-webapp',
    ]);
  });

  /**
   * The prompt says to choose only from the list. A model does not always obey,
   * and an invented name must add nothing rather than become an id the client
   * cannot resolve.
   */
  it('drops a name that no module has', () => {
    expect(matchModuleNames('Frontend, Server', MODULES)).toEqual([
      'module-server',
    ]);
    expect(matchModuleNames('Frontend', MODULES)).toEqual([]);
  });

  /** An empty answer is the correct answer when the issue does not say. */
  it('returns nothing for an empty answer', () => {
    expect(matchModuleNames('', MODULES)).toEqual([]);
    expect(matchModuleNames(null, MODULES)).toEqual([]);
    expect(matchModuleNames(undefined, MODULES)).toEqual([]);
  });

  it('returns one id when the model names the same module twice', () => {
    expect(matchModuleNames('Server, server', MODULES)).toEqual([
      'module-server',
    ]);
  });

  it('returns nothing when the workspace has no module', () => {
    expect(matchModuleNames('Server', [])).toEqual([]);
  });
});

describe('dismissedModuleIds', () => {
  it('reads the list a dismissal wrote', () => {
    expect(
      dismissedModuleIds({ dismissedModuleIds: ['module-server'] }),
    ).toEqual(['module-server']);
  });

  /**
   * `metadata` is a free Json column that predates this feature, so it holds
   * whatever an older build put there. Every shape that is not a list of
   * strings has to read as nothing rather than throw inside a suggestion run.
   */
  it('reads a row that was written before dismissals existed', () => {
    expect(dismissedModuleIds(null)).toEqual([]);
    expect(dismissedModuleIds(undefined)).toEqual([]);
    expect(dismissedModuleIds({})).toEqual([]);
    expect(dismissedModuleIds({ somethingElse: true })).toEqual([]);
  });

  it('reads a value of the wrong shape as nothing', () => {
    expect(dismissedModuleIds({ dismissedModuleIds: 'module-server' })).toEqual(
      [],
    );
    expect(dismissedModuleIds('not an object')).toEqual([]);
  });

  it('drops an entry that is not a string', () => {
    expect(
      dismissedModuleIds({ dismissedModuleIds: ['module-server', 7, null] }),
    ).toEqual(['module-server']);
  });
});

describe('withDismissedModule', () => {
  it('records the first dismissal', () => {
    expect(withDismissedModule(null, 'module-server')).toEqual({
      dismissedModuleIds: ['module-server'],
    });
  });

  it('adds a second dismissal to the first', () => {
    expect(
      withDismissedModule(
        { dismissedModuleIds: ['module-server'] },
        'module-webapp',
      ),
    ).toEqual({ dismissedModuleIds: ['module-server', 'module-webapp'] });
  });

  it('records a repeated dismissal once', () => {
    expect(
      withDismissedModule(
        { dismissedModuleIds: ['module-server'] },
        'module-server',
      ),
    ).toEqual({ dismissedModuleIds: ['module-server'] });
  });

  /** The column belongs to more than this feature. */
  it('keeps every other key of the metadata', () => {
    expect(
      withDismissedModule({ somethingElse: true }, 'module-server'),
    ).toEqual({
      somethingElse: true,
      dismissedModuleIds: ['module-server'],
    });
  });
});
