import type { AgentRunVerification } from '@vantikhq/types';

/** The verification a run inherits, and which modules could not agree on it. */
export interface VerificationChoice {
  verification: AgentRunVerification;
  /**
   * Fields two modules defined differently. Left unset in `verification`
   * rather than resolved, and named here so the disagreement can be logged
   * instead of disappearing.
   */
  conflicts: string[];
}

const COMMAND_FIELDS = [
  'testCommand',
  'lintCommand',
  'typecheckCommand',
  'buildCommand',
] as const;

/**
 * The verification commands an issue's modules agree on.
 *
 * Field by field, because agreement is per command and not per module. An
 * issue against two modules of one monorepo usually has a shared test runner
 * and different build commands, and taking the whole block from whichever
 * module sorted first would silently pick one module's build for the other's
 * code.
 *
 * A field only two modules *disagree* on is dropped, on the same reasoning as
 * `chooseRepo`: running the wrong test command costs more than running none.
 * The agent is told what it may run, and a missing command means it does not
 * claim to have verified something it did not.
 *
 * Setup commands are the exception and are unioned, in module order with
 * duplicates removed. They install things, so two modules asking for two
 * different installs both want to happen — and unlike a test command, running
 * one extra is not a wrong answer.
 */
export function chooseVerification(
  modules: Array<{ verification: unknown }>,
): VerificationChoice {
  const found = modules
    .map((row) => asVerification(row.verification))
    .filter((row): row is AgentRunVerification => row !== null);

  const verification: AgentRunVerification = {};
  const conflicts: string[] = [];

  for (const field of COMMAND_FIELDS) {
    const values = [
      ...new Set(
        found
          .map((row) => row[field])
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    if (values.length === 1) {
      [verification[field]] = values;
    } else if (values.length > 1) {
      conflicts.push(field);
    }
  }

  const setup = [
    ...new Set(found.flatMap((row) => row.setupCommands ?? [])),
  ].filter(Boolean);

  if (setup.length) {
    verification.setupCommands = setup;
  }

  return { verification, conflicts };
}

/**
 * A stored blob read back as verification, or null.
 *
 * The column is free-form JSON, so it may hold anything a past shape or a
 * direct write left there. Every field is checked rather than trusted: these
 * strings become commands the runner executes.
 */
function asVerification(value: unknown): AgentRunVerification | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const verification: AgentRunVerification = {};

  for (const field of COMMAND_FIELDS) {
    if (typeof raw[field] === 'string' && raw[field]) {
      verification[field] = raw[field] as string;
    }
  }

  if (Array.isArray(raw.setupCommands)) {
    const commands = raw.setupCommands.filter(
      (entry): entry is string => typeof entry === 'string' && Boolean(entry),
    );

    if (commands.length) {
      verification.setupCommands = commands;
    }
  }

  return Object.keys(verification).length ? verification : null;
}
