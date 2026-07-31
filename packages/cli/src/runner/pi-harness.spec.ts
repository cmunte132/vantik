/**
 * The harness protocol.
 *
 * These exist because the bundled default harness shipped unable to finish a
 * run, and nothing noticed. The end-to-end verification used a stub that spoke
 * the contract as documented and then exited — so it never exercised the two
 * things that were wrong: Pi's RPC mode is a server that does not exit, and its
 * event names are not the ones this file was written against.
 *
 * A stub that exits is a test of the stub. The fixture below stays alive after
 * it settles, exactly as Pi does.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PiHarness,
  assistantTextOf,
  describe as describeEvent,
  modelOf,
} from './pi-harness';

describe('describe', () => {
  it('names the tool Pi actually reports', () => {
    // Pi emits `tool_execution_start` with `toolName`. This file used to look
    // for `tool_call` with `name`, so the only event it ever matched was
    // turn_end and a whole run logged nothing but "Finished a turn".
    expect(
      describeEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pnpm lint' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toEqual({
      message: 'bash: pnpm lint',
      phase: 'implement',
      data: { kind: 'bash', command: 'pnpm lint' },
    });
  });

  it('says what a file tool touched', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeEvent({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'apps/server/src/main.ts' } } as any),
    ).toEqual({
      message: 'edit: apps/server/src/main.ts',
      phase: 'implement',
      data: { kind: 'write', target: 'apps/server/src/main.ts' },
    });
  });

  it('falls back to the tool name when the arguments say nothing useful', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeEvent({ type: 'tool_execution_start', toolName: 'read', args: {} } as any),
    ).toEqual({
      message: 'Running read',
      phase: 'implement',
      data: { kind: 'read' },
    });
  });

  it('maps Pi’s tool set onto the five kinds the app can draw', () => {
    const kindOf = (toolName: string, args: Record<string, string> = {}) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (describeEvent({ type: 'tool_execution_start', toolName, args } as any)
        ?.data as { kind: string })?.kind;

    expect(kindOf('read')).toBe('read');
    expect(kindOf('ls')).toBe('read');
    expect(kindOf('write')).toBe('write');
    expect(kindOf('edit')).toBe('write');
    expect(kindOf('grep', { pattern: 'LOCAL_REPO_SLUG' })).toBe('search');
    expect(kindOf('find')).toBe('search');
    expect(kindOf('bash', { command: 'git status' })).toBe('bash');
  });

  it('calls a test run a test, because it is the step a reader looks for', () => {
    const data = describeEvent({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'cd apps/server && pnpm exec jest repo-routing' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)?.data as { kind: string };

    expect(data.kind).toBe('test');
  });

  it('carries the ref, so an outcome can be matched to the step it belongs to', () => {
    const start = describeEvent({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call_7',
      args: { command: 'pnpm build' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const end = describeEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'call_7',
      isError: true,
      result: 'boom\n\nCommand exited with code 2',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect((start?.data as { ref: string }).ref).toBe('call_7');
    expect(end?.level).toBe('ERROR');
    expect(end?.data).toEqual({
      kind: 'bash',
      ref: 'call_7',
      ok: false,
      exit: 2,
      output: 'boom\n\nCommand exited with code 2',
    });
  });

  it('reads output out of the content blocks a tool result arrives in', () => {
    const end = describeEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      isError: true,
      result: { content: [{ type: 'text', text: "Cannot find module '.prisma/client'" }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect((end?.data as { output: string }).output).toBe(
      "Cannot find module '.prisma/client'",
    );
  });

  it('counts a passing test run, which is the one success worth reporting', () => {
    const end = describeEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'call_9',
      isError: false,
      result: 'Tests: 6 passed, 6 total',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(end?.data).toEqual({
      kind: 'test',
      ref: 'call_9',
      ok: true,
      passed: 6,
    });
  });

  it('says nothing about a step that worked', () => {
    // The start event already reported it. Repeating every success to say it
    // was fine is how the log filled with lines nobody read.
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeEvent({ type: 'tool_execution_end', toolName: 'read', isError: false } as any),
    ).toBeNull();
  });

  it('records a retry as a warning, because a run that retries is a run in trouble', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(describeEvent({ type: 'auto_retry_start' } as any)?.level).toBe('WARN');
  });

  it('no longer logs a line per turn', () => {
    // Nineteen of the forty-three lines in a real run were this one event.
    // The turn still counts towards iterations in `onLine`; it is just not
    // something the agent did.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(describeEvent({ type: 'turn_end' } as any)).toBeNull();
  });

  it('keeps everything else out of the log', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(describeEvent({ type: 'message_update' } as any)).toBeNull();
  });
});

describe('modelOf', () => {
  it('reads the model off the message, since --model is a pattern and not an id', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelOf({ type: 'message_end', message: { model: 'google/gemini-3.6-flash' } } as any),
    ).toBe('google/gemini-3.6-flash');
  });

  it('is null when nothing said', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(modelOf({ type: 'turn_end' } as any)).toBeNull();
  });
});

describe('assistantTextOf', () => {
  it('joins the text blocks of a finished assistant message', () => {
    // The old shape looked for `{type:"message", text}`, which Pi never emits,
    // so no run ever captured a summary.
    expect(
      assistantTextOf({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Added the spec.' },
            { type: 'toolCall', name: 'edit' },
            { type: 'text', text: 'All eight cases pass.' },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toBe('Added the spec.\nAll eight cases pass.');
  });

  it('ignores the user’s own message', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assistantTextOf({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } as any),
    ).toBeNull();
  });
});

describe('PiHarness against a harness that behaves like Pi', () => {
  /** Writes a fake harness and returns the command that runs it. */
  function fixture(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'pi-harness-'));
    const file = join(directory, 'fake.js');
    writeFileSync(file, body);

    return `node ${file}`;
  }

  function request(command: string) {
    const events: Array<{ message: string }> = [];

    return {
      events,
      input: {
        workdir: process.cwd(),
        contextPack: {
          issue: { key: 'ENG-1', title: 'A thing', description: 'Do it' },
        },
        verification: {},
        limits: {},
        onEvent: (event: { message: string }) => events.push(event),
        signal: new AbortController().signal,
      },
      harness: new PiHarness({ command }),
    };
  }

  it('finishes when the agent settles, without the process exiting', async () => {
    // The bug this whole file exists for. A server that answers and waits is
    // correct RPC behaviour; waiting for it to exit means every run burns its
    // wall-clock budget and reports BUDGET_EXHAUSTED instead of its work.
    const command = fixture(`
      process.stdin.on('data', () => {
        process.stdout.write(JSON.stringify({ type: 'turn_end' }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', model: 'test/model', content: [{ type: 'text', text: 'Done.' }] },
        }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
      });
      // Deliberately stays alive, exactly as pi --mode rpc does.
      setInterval(() => {}, 1000);
    `);

    const { harness, input } = request(command);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await harness.run(input as any);

    expect(result.outcome).toBe('changed');
    expect(result.summary).toBe('Done.');
    expect(result.modelId).toBe('test/model');
    expect(result.iterationCount).toBe(1);
  }, 20_000);

  it('still handles a harness that simply exits, which a custom one will', async () => {
    const command = fixture(`
      process.stdin.on('data', () => {
        process.stdout.write(JSON.stringify({ type: 'turn_end' }) + '\\n');
        process.exit(0);
      });
    `);

    const { harness, input } = request(command);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await harness.run(input as any);

    expect(result.outcome).toBe('changed');
    expect(result.iterationCount).toBe(1);
  }, 20_000);

  it('stops a harness that spirals, instead of letting it run to the wall clock', async () => {
    // What was actually observed: turn after turn, seconds apart, nothing
    // else. Before the ceilings this ran until the timeout and then reported
    // that it had run out of time, which says nothing about why.
    const command = fixture(`
      process.stdin.on('data', () => {
        setInterval(() => {
          process.stdout.write(JSON.stringify({
            type: 'turn_end',
            message: { role: 'assistant', usage: { input: 10, output: 10, cost: { total: 0.001 } } },
          }) + '\\n');
        }, 5);
      });
      setInterval(() => {}, 1000);
    `);

    const { harness, input, events } = request(command);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await harness.run(input as any);

    expect(result.outcome).toBe('failed');
    expect(result.failure).toBe('BUDGET_EXHAUSTED');
    // The reason is the value: a run that stopped without one is a mystery.
    expect(result.error).toContain('without using a tool');
    expect(events.some((event) => event.message.startsWith('Stopping'))).toBe(
      true,
    );
  }, 20_000);

  it('keeps a record whole when the model emits a line separator inside it', async () => {
    // U+2028 is legal inside a JSON string and Node's readline splits on it,
    // which would cut this record in two and lose the summary. Pi's own RPC
    // documentation names readline as non-compliant for exactly this.
    const command = fixture(`
      process.stdin.on('data', () => {
        process.stdout.write(JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'before\\u2028after' }] },
        }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
      });
      setInterval(() => {}, 1000);
    `);

    const { harness, input } = request(command);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await harness.run(input as any);

    expect(result.summary).toBe('before after');
  }, 20_000);
});
