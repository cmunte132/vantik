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
        args: { command: 'pnpm test' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toEqual({ message: 'bash: pnpm test', phase: 'implement' });
  });

  it('says what a file tool touched', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeEvent({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'apps/server/src/main.ts' } } as any),
    ).toEqual({ message: 'edit: apps/server/src/main.ts', phase: 'implement' });
  });

  it('falls back to the tool name when the arguments say nothing useful', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeEvent({ type: 'tool_execution_start', toolName: 'read', args: {} } as any),
    ).toEqual({ message: 'Running read', phase: 'implement' });
  });

  it('records a retry as a warning, because a run that retries is a run in trouble', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(describeEvent({ type: 'auto_retry_start' } as any)?.level).toBe('WARN');
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
