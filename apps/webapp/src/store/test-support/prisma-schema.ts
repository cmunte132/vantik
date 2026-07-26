import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A minimal reader for the server's `schema.prisma`.
 *
 * The store models mirror database columns, and the two drift apart silently:
 * a column is made nullable in a migration, the API starts returning null for
 * it, and MobX-State-Tree rejects the record. Reading the schema here lets a
 * test assert the mirror still holds instead of waiting for the UI to blank
 * out. Parsing the file with regular expressions is enough for that — the
 * alternative, @prisma/internals, is a server dependency and pulls in the
 * query engine.
 */

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../server/prisma/schema.prisma',
);

/** Prisma's built-in scalars. Anything else is an enum or a relation. */
const SCALAR_TYPES = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

export interface PrismaField {
  name: string;
  type: string;
  isList: boolean;
  /** Declared with `?`, so the API serialises it as null when unset. */
  isOptional: boolean;
}

export interface PrismaModel {
  name: string;
  /** Scalar and enum fields only: relations never appear in a sync payload. */
  fields: PrismaField[];
}

function readSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function collectEnumNames(schema: string): Set<string> {
  const names = new Set<string>();

  for (const match of schema.matchAll(/^enum\s+(\w+)\s*\{/gm)) {
    names.add(match[1]);
  }

  return names;
}

export function parsePrismaModels(): Map<string, PrismaModel> {
  const schema = readSchema();
  const enumNames = collectEnumNames(schema);
  const models = new Map<string, PrismaModel>();

  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const fields: PrismaField[] = [];

    for (const line of body.split('\n')) {
      const trimmed = line.trim();

      if (
        trimmed === '' ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('@@')
      ) {
        continue;
      }

      const field = trimmed.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);

      if (!field) {
        continue;
      }

      const [, fieldName, fieldType, list, optional] = field;

      // A relation is a field whose type is another model. It is fetched
      // separately and carried by its foreign key column, which is a scalar
      // and stays in the list.
      if (!SCALAR_TYPES.has(fieldType) && !enumNames.has(fieldType)) {
        continue;
      }

      fields.push({
        name: fieldName,
        type: fieldType,
        isList: Boolean(list),
        isOptional: Boolean(optional),
      });
    }

    models.set(name, { name, fields });
  }

  return models;
}

export function getPrismaModel(name: string): PrismaModel {
  const model = parsePrismaModels().get(name);

  if (!model) {
    throw new Error(
      `No model named "${name}" in schema.prisma. Was it renamed or removed?`,
    );
  }

  return model;
}
