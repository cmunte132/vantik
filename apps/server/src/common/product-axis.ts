import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

/**
 * Helpers that the product, module and capability services share.
 *
 * A product and a module each carry a short key, and a module must have exactly
 * one owner. Both rules apply on create and on update, and both services would
 * otherwise hold their own copy of them.
 */

/**
 * Makes a short key from a name. The key holds lower case letters, digits and
 * dashes, and nothing else.
 *
 * "Cloud Platform" becomes "cloud-platform". A name of symbols alone leaves
 * nothing behind, so the caller gets a fallback instead of an empty key.
 */
export function toKey(name: string, fallback = 'item'): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return key || fallback;
}

/**
 * Returns a key that no other row in this workspace holds.
 *
 * The unique index is on the workspace and the key together, so a second product
 * named "Docs" in the same workspace fails the insert. A person who types the
 * same name twice gets "docs-2" and not an error, because the key is a detail of
 * the schema and not something they asked for.
 */
export async function uniqueKey(
  candidate: string,
  taken: (key: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(candidate))) {
    return candidate;
  }

  for (let suffix = 2; suffix < 100; suffix++) {
    const next = `${candidate}-${suffix}`;

    if (!(await taken(next))) {
      return next;
    }
  }

  // A hundred rows with the same name is not a real workspace. Fall back to
  // something that cannot collide rather than loop for ever.
  return `${candidate}-${Date.now()}`;
}

/**
 * Refuses a module that has two owners, and a module that has none.
 *
 * A check constraint in the database says the same thing, and it is the one that
 * makes the rule true. This function exists so that a person sees a sentence
 * that names the problem, and not a constraint violation from postgres.
 */
export function assertSingleOwner(
  ownerTeamId: string | null | undefined,
  ownerProductId: string | null | undefined,
): void {
  const owners = [ownerTeamId, ownerProductId].filter(Boolean).length;

  if (owners === 1) {
    return;
  }

  throw new BadRequestException({
    message:
      owners === 0
        ? 'A module needs one owner. Give it a team when it holds internal ' +
          'tools, or a product when it ships to customers.'
        : 'A module has one owner. Give it a team or a product, and use ' +
          'linkedTeamIds or linkedProductIds for the others.',
  });
}

/**
 * Removes a module id from every list that holds it.
 *
 * A module is deleted softly, so nothing in the database drops the id for us.
 * An id left behind in Capability.moduleIds or Issue.moduleIds renders as a chip
 * for a module that no longer exists, and a person cannot remove it.
 */
export async function forgetModule(
  prisma: PrismaService,
  moduleId: string,
): Promise<void> {
  const [capabilities, issues] = await Promise.all([
    prisma.capability.findMany({
      where: { moduleIds: { has: moduleId }, deleted: null },
      select: { id: true, moduleIds: true },
    }),
    prisma.issue.findMany({
      where: { moduleIds: { has: moduleId }, deleted: null },
      select: { id: true, moduleIds: true },
    }),
  ]);

  await Promise.all([
    ...capabilities.map((capability) =>
      prisma.capability.update({
        where: { id: capability.id },
        data: { moduleIds: capability.moduleIds.filter((id) => id !== moduleId) },
      }),
    ),
    ...issues.map((issue) =>
      prisma.issue.update({
        where: { id: issue.id },
        data: { moduleIds: issue.moduleIds.filter((id) => id !== moduleId) },
      }),
    ),
  ]);
}
