import type { AgentExecutor } from './executor.interface';
import { ExecutorRegistry } from './executor.registry';

const executor = (key: string): AgentExecutor => ({
  key,
  label: key,
  availability: jest.fn(async () => ({ available: true as const })),
  dispatch: jest.fn(async (): Promise<void> => undefined),
  cancel: jest.fn(async (): Promise<void> => undefined),
});

function registryOf(...keys: string[]) {
  const registry = new ExecutorRegistry();
  keys.forEach((key) => registry.register(executor(key)));
  return registry;
}

describe('ExecutorRegistry.resolve', () => {
  it('falls back to hosted when nothing is named and several are registered', () => {
    expect(registryOf('local', 'hosted').resolve({}).key).toBe('hosted');
  });

  it('still lets a request name the other one', () => {
    expect(
      registryOf('hosted', 'local').resolve({ requested: 'local' }).key,
    ).toBe('local');
  });

  it('asks for a choice when several are registered and none is hosted', () => {
    expect(() => registryOf('a', 'b').resolve({})).toThrow(/name one/);
  });

  it('uses the only executor there is', () => {
    expect(registryOf('local').resolve({}).key).toBe('local');
  });
});
