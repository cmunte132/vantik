import { agentBoundExecutor, workspaceAgentDefaults } from './agent-run-settings';

/**
 * `Workspace.preferences` is free-form JSON that an operator or an older build
 * may have hand-edited, so nothing read out of it is trusted. Every field is
 * checked on the way back and a value of the wrong type is dropped rather than
 * passed on — a dropped value falls back to a default that is known to be
 * safe, while a coerced one reaches a command line or a registry as itself.
 */
describe('workspaceAgentDefaults', () => {
  it('reads back what a well-formed blob stores', () => {
    const defaults = workspaceAgentDefaults({
      agentRuns: {
        defaultExecutor: 'hosted',
        repo: { testCommand: 'pnpm test' },
        model: { provider: 'openrouter', model: 'gemini-3.6-flash' },
        phases: { specify: true, score: false },
      },
    });

    expect(defaults).toEqual({
      defaultExecutor: 'hosted',
      repo: { testCommand: 'pnpm test' },
      model: { provider: 'openrouter', model: 'gemini-3.6-flash' },
      phases: { specify: true, score: false },
    });
  });

  it('returns empty defaults when nothing is configured', () => {
    expect(workspaceAgentDefaults(null)).toEqual({
      defaultExecutor: null,
      repo: {},
      model: {},
      phases: {},
    });
    expect(workspaceAgentDefaults({})).toEqual({
      defaultExecutor: null,
      repo: {},
      model: {},
      phases: {},
    });
  });

  describe('phases', () => {
    it('drops the string "false" rather than letting it enable the phase', () => {
      // The case this hardening exists for. `"false"` is a non-empty string
      // and so is truthy; spread over the runner's defaults it would switch
      // `specify` *on* to express that it is off.
      const { phases } = workspaceAgentDefaults({
        agentRuns: { phases: { specify: 'false' } },
      });

      expect(phases.specify).toBeUndefined();
      expect(phases).toEqual({});
    });

    it('drops a non-boolean under any of the three flags', () => {
      const { phases } = workspaceAgentDefaults({
        agentRuns: {
          phases: { specify: 1, score: {}, review: 'true' },
        },
      });

      expect(phases).toEqual({});
    });

    it('keeps the well-typed flags and drops only the bad one', () => {
      const { phases } = workspaceAgentDefaults({
        agentRuns: {
          phases: { specify: true, score: 'false', review: false },
        },
      });

      expect(phases).toEqual({ specify: true, review: false });
    });

    it('ignores keys that are not phase names', () => {
      const { phases } = workspaceAgentDefaults({
        agentRuns: { phases: { specify: true, implement: true } },
      });

      expect(phases).toEqual({ specify: true });
    });

    it('returns no flags when phases is not an object', () => {
      for (const stored of ['specify', 3, true, ['specify'], null]) {
        expect(
          workspaceAgentDefaults({ agentRuns: { phases: stored } }).phases,
        ).toEqual({});
      }
    });
  });

  describe('defaultExecutor', () => {
    it('keeps a non-empty string', () => {
      expect(
        workspaceAgentDefaults({ agentRuns: { defaultExecutor: 'byo' } })
          .defaultExecutor,
      ).toBe('byo');
    });

    it('reads back as null for anything that is not a non-empty string', () => {
      // Each of these would otherwise reach the executor registry as a lookup
      // key, which expects a name.
      for (const stored of [1, {}, [], true, '', null]) {
        expect(
          workspaceAgentDefaults({ agentRuns: { defaultExecutor: stored } })
            .defaultExecutor,
        ).toBeNull();
      }
    });
  });

  describe('model and repo are unchanged', () => {
    it('drops a model id outside the safe set and an unknown thinking level', () => {
      const { model } = workspaceAgentDefaults({
        agentRuns: {
          model: {
            provider: 'openrouter',
            model: 'rm -rf /; gpt-4',
            thinking: 'extremely-hard',
          },
        },
      });

      expect(model).toEqual({ provider: 'openrouter' });
    });

    it('keeps a known thinking level', () => {
      const { model } = workspaceAgentDefaults({
        agentRuns: { model: { thinking: 'high' } },
      });

      expect(model.thinking).toBe('high');
    });

    it('returns an empty repo when the stored value is not an object', () => {
      expect(
        workspaceAgentDefaults({ agentRuns: { repo: 'pnpm test' } }).repo,
      ).toEqual({});
    });
  });
});

describe('agentBoundExecutor', () => {
  it('names the executor an agent is bound to', () => {
    expect(agentBoundExecutor({ agent: { executor: 'byo' } })).toBe('byo');
  });

  it('is null when the agent names no executor, or names one badly', () => {
    expect(agentBoundExecutor(null)).toBeNull();
    expect(agentBoundExecutor({})).toBeNull();
    expect(agentBoundExecutor({ agent: {} })).toBeNull();
    expect(agentBoundExecutor({ agent: { executor: '' } })).toBeNull();
    expect(agentBoundExecutor({ agent: { executor: 7 } })).toBeNull();
  });
});
