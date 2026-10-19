import { realpath } from 'fs/promises';
import { resolve } from 'path';

import { ConflictException } from '@nestjs/common';

import { type MirrorTargets } from './mirror-targets';

/**
 * The identity of the repository that a mirror writes into.
 *
 * Every target writes the same refs, `refs/vantik/issues` and
 * `refs/vantik/inbox/*`, into its source. Two targets of one source would
 * write over each other's snapshot and apply each other's hand-offs, across
 * workspaces too. The key says which targets share a source.
 */

/** A local path, with its links followed, so that two paths to one directory match. */
export async function localSourceKey(path: string): Promise<string> {
  const absolute = resolve(path);

  try {
    return `local:${await realpath(absolute)}`;
  } catch {
    // A directory that is gone cannot be a link to another one.
    return `local:${absolute}`;
  }
}

/**
 * A clone address without its scheme, credentials, case, trailing slash and
 * `.git`. Host names ignore case, and the hosts that Vantik reads treat the
 * owner and the name the same way, so the whole key is lower case.
 */
export function remoteSourceKey(cloneUrl: string): string {
  const trimmed = cloneUrl.trim();

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');

    return `remote:${url.host}${path}`.toLowerCase();
  } catch {
    return `remote:${trimmed.replace(/\/+$/, '').replace(/\.git$/i, '')}`.toLowerCase();
  }
}

/**
 * Refuses to turn a mirror on while another target, in any workspace, has the
 * mirror on for the same source. The repository that is asked about does not
 * count against itself.
 */
export async function assertSourceUnclaimed(
  tier: MirrorTargets,
  sourceKey: string,
  self: { integrationAccountId: string; externalRepoId: string },
): Promise<void> {
  const claimed = (await tier.list()).some(
    (target) =>
      target.sourceKey === sourceKey &&
      !(
        target.integrationAccountId === self.integrationAccountId &&
        target.externalRepoId === self.externalRepoId
      ),
  );

  if (claimed) {
    throw new ConflictException(
      'Another connection already mirrors issues into this repository. One repository can carry one issue mirror, so turn that one off first.',
    );
  }
}
