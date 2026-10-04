import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { DATABASE_URL } from '../src/env';

/**
 * Writes rows straight into the stack's database, for the few records the docs
 * show that no endpoint makes: agent runs, which only a real executor creates,
 * and the repository connection a run's plan reads.
 *
 * Everything else in the seed goes through the API, so keep this to rows that
 * have no other way in. Each one here is a copy of the schema, and breaks when
 * the schema changes, which is the point: the capture then fails in the
 * release workflow instead of drawing a run page from stale columns.
 *
 * Replication carries these rows to the webapp like any other write.
 */
export class Database {
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<Database> {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query('SET search_path TO vantik');
    return new Database(client);
  }

  /**
   * Inserts one row and returns its id. Ids and `updatedAt` have no database
   * default, so both are filled in here, `updatedAt` only for a table that has
   * one. Objects become JSON.
   */
  async insert(
    table: string,
    row: Record<string, unknown>,
    { updatedAt = true }: { updatedAt?: boolean } = {},
  ): Promise<string> {
    const values = {
      id: randomUUID(),
      ...(updatedAt ? { updatedAt: new Date() } : {}),
      ...row,
    };
    const columns = Object.keys(values);
    const params = columns.map((column) => {
      const value = values[column as keyof typeof values];
      // The columns are timestamps without a zone, holding UTC. pg would send
      // a Date in the machine's zone, and Postgres drops the offset, so a run
      // seeded outside UTC would read as hours old.
      if (value instanceof Date) return value.toISOString().replace('Z', '');
      return value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : value;
    });
    await this.client.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
    return values.id as string;
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.client.query(sql, params)).rows as T[];
  }

  async close() {
    await this.client.end();
  }
}
