import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { providerById } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { type CatalogueModel, fetchCatalogue } from './model-catalogue';

export type CredentialKind = 'MODEL_API_KEY' | 'GIT_TOKEN';

/** What the API is allowed to say about a stored secret. */
export interface CredentialHandle {
  kind: CredentialKind;
  /** Which provider a model key belongs to. Empty for a git token. */
  provider: string;
  /** `…a1b2`. Enough to tell one key from another, useless to anyone else. */
  hint: string;
  baseUrl: string | null;
  updatedAt: Date;
  rotatedAt: Date | null;
  /** What this key could reach when it was last checked. */
  models?: CatalogueModel[];
  modelsCheckedAt?: Date | null;
}

/** Everything a response may carry about a credential, and nothing more. */
const HANDLE_FIELDS = {
  kind: true,
  provider: true,
  hint: true,
  baseUrl: true,
  updatedAt: true,
  rotatedAt: true,
  models: true,
  modelsCheckedAt: true,
} as const;

/**
 * The workspace credential store.
 *
 * Write-only over the API by construction: nothing here returns a plaintext
 * secret to a caller, and the only method that decrypts is used internally by
 * the executor. A "read it back to check it" endpoint is exactly how a
 * credential store becomes a credential leak, so there is not one.
 *
 * Encryption is real but it is the second line. The property that actually
 * matters is architectural — the git token never enters the sandbox, so a
 * prompt-injected agent has nothing to exfiltrate regardless of how well the
 * database is protected.
 */
@Injectable()
export class CredentialsService {
  constructor(private prisma: PrismaService) {}

  async list(workspaceId: string): Promise<CredentialHandle[]> {
    const rows = await this.prisma.workspaceCredential.findMany({
      where: { workspaceId, deleted: null },
      // Named explicitly. A `select` that grows by accident is how the
      // ciphertext ends up in a response.
      select: HANDLE_FIELDS,
      orderBy: { provider: 'asc' },
    });

    return rows as unknown as CredentialHandle[];
  }

  /**
   * What this workspace's keys can actually drive.
   *
   * The catalogue was already fetched and stored when each key was saved, so
   * this is a read rather than a round trip to every provider. Separate from
   * `list` because that one is admin-only and rightly so — it carries hints,
   * rotation times and base urls. Choosing a model when delegating is an
   * ordinary member action, and it needs exactly the model ids and nothing
   * else about the credential they came from.
   *
   * Empty is a real answer: a provider with no catalogue endpoint stores a
   * working key and no list. The caller falls back to the workspace default,
   * which is what would have been used anyway.
   */
  async models(
    workspaceId: string,
  ): Promise<Array<{ provider: string; id: string; label: string }>> {
    const rows = await this.prisma.workspaceCredential.findMany({
      where: { workspaceId, deleted: null, kind: 'MODEL_API_KEY' },
      select: { provider: true, models: true },
      orderBy: { provider: 'asc' },
    });

    return rows.flatMap((row) => {
      const models = (row.models ?? []) as unknown as CatalogueModel[];

      return Array.isArray(models)
        ? models.map((model) => ({
            provider: row.provider,
            id: model.id,
            label: model.label ?? model.id,
          }))
        : [];
    });
  }

  /**
   * Stores or rotates a secret, and hands back only a masked handle.
   *
   * A model key is checked against its provider before it is stored, and a key
   * the provider refuses is not stored at all. This is the difference between
   * finding out about a typo here and finding out from a failed run an hour
   * later — and because the check is "list what this key can reach", the same
   * call that validates also produces the model list the screen then offers.
   *
   * A provider that cannot be reached is not a refusal. The key is stored with
   * no catalogue and the caller is told why, because an outage at the provider
   * says nothing about whether the person pasted the right thing.
   *
   * Upserts rather than appends: one credential per provider per workspace, so
   * there is never ambiguity about which key a run used.
   */
  async put(input: {
    workspaceId: string;
    kind: CredentialKind;
    provider?: string;
    secret: string;
    baseUrl?: string;
    createdById?: string;
  }): Promise<CredentialHandle & { note?: string }> {
    const secret = input.secret.trim();

    if (!secret) {
      throw new BadRequestException({ message: 'The secret is empty.' });
    }

    // Empty rather than null for a git token: the unique index has to
    // constrain it, and Postgres treats nulls as distinct.
    const provider =
      input.kind === 'MODEL_API_KEY' ? (input.provider ?? '') : '';
    const known = provider ? providerById(provider) : undefined;

    if (input.kind === 'MODEL_API_KEY' && !known) {
      throw new BadRequestException({
        message: `Unknown model provider "${provider}".`,
      });
    }

    if (known?.baseUrl?.required && !input.baseUrl?.trim()) {
      throw new BadRequestException({
        message: `${known.label} needs the endpoint of your own resource.`,
      });
    }

    const checked = known
      ? await fetchCatalogue(known, secret, input.baseUrl)
      : null;

    if (checked?.outcome === 'rejected') {
      // Nothing is written. Storing a key the provider has already said no to
      // would put the workspace in exactly the state this check exists to
      // prevent: configured, and unable to run.
      throw new BadRequestException({ message: checked.message });
    }

    const sealed = seal(secret);
    const hint = hintFor(secret);

    // Soft-deleted rows are found on purpose, so removing a credential and
    // adding another reuses the row rather than leaving a second one behind.
    const existing = await this.prisma.workspaceCredential.findFirst({
      where: { workspaceId: input.workspaceId, kind: input.kind, provider },
      select: { id: true, deleted: true },
    });

    // Rotation means replacing a *live* secret. Reviving a removed one is a new
    // credential that happens to reuse a row, and stamping `rotatedAt` for it
    // made the settings screen report "rotated" for a key that had just been
    // added for the first time since its predecessor was deleted.
    const rotated = Boolean(existing && !existing.deleted);

    const data = {
      ...sealed,
      hint,
      baseUrl: input.baseUrl?.trim() || null,
      deleted: null as Date | null,
      // Cast because Prisma's JSON input type does not accept a plain array of
      // interfaces, and `DbNull` is how a nullable JSON column is cleared —
      // a plain `null` reads as "leave it alone".
      ...(checked?.outcome === 'ok'
        ? {
            models: checked.models as unknown as Prisma.InputJsonValue,
            modelsCheckedAt: new Date(),
          }
        : {
            models: Prisma.DbNull,
            modelsCheckedAt: null as Date | null,
          }),
      ...(rotated ? { rotatedAt: new Date() } : { rotatedAt: null }),
    };

    const row = existing
      ? await this.prisma.workspaceCredential.update({
          where: { id: existing.id },
          data,
          select: HANDLE_FIELDS,
        })
      : await this.prisma.workspaceCredential.create({
          data: {
            ...data,
            workspaceId: input.workspaceId,
            kind: input.kind,
            provider,
            createdById: input.createdById,
          },
          select: HANDLE_FIELDS,
        });

    return {
      ...(row as unknown as CredentialHandle),
      // Said out loud rather than left to look like an empty catalogue. "We
      // stored it but could not check it" and "this key reaches no models" are
      // different situations.
      ...(checked?.outcome === 'unknown' ? { note: checked.message } : {}),
    };
  }

  async remove(
    workspaceId: string,
    kind: CredentialKind,
    provider = '',
  ): Promise<void> {
    const { count } = await this.prisma.workspaceCredential.updateMany({
      where: { workspaceId, kind, provider, deleted: null },
      data: { deleted: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException({
        message: `This workspace has no ${provider || kind} credential configured.`,
      });
    }
  }

  /** Whether a workspace has everything the hosted executor needs. */
  async has(workspaceId: string, kind: CredentialKind): Promise<boolean> {
    const row = await this.prisma.workspaceCredential.findFirst({
      where: { workspaceId, kind, deleted: null },
      select: { id: true },
    });

    return Boolean(row);
  }

  /**
   * Where a workspace's model access comes from.
   *
   * Two answers, and deliberately no third. An agent run only ever calls a
   * model with a key somebody in this workspace deliberately configured — it
   * never inherits whatever drives Vantik's own AI features. A member who has
   * not added a key here has not opted into agent runs, and silently spending
   * the deployment's budget on their behalf would decide that for them.
   */
  async modelAccess(workspaceId: string): Promise<ModelAccess> {
    return (await this.has(workspaceId, 'MODEL_API_KEY'))
      ? { source: 'workspace' }
      : { source: 'none' };
  }

  /**
   * The model key a run should actually use, and whose it is.
   *
   * The provider comes back with the secret because everything downstream
   * needs it: the environment variable the harness reads the key from, the
   * host the sandbox is allowed to reach, and the `--provider` Pi is told to
   * use. A secret without its provider is not usable — that was the shape
   * before this, and it is why a stored key reached the sandbox under a name
   * no harness reads.
   *
   * `wanted` is the provider the run asked for. Without one, the workspace's
   * only configured provider is used — and when there are several and none
   * was named, nothing is: picking one would spend a workspace's money at a
   * company it did not choose for this run.
   */
  async revealModelKey(
    workspaceId: string,
    wanted?: string,
  ): Promise<ModelCredential | null> {
    const rows = await this.prisma.workspaceCredential.findMany({
      where: {
        workspaceId,
        kind: 'MODEL_API_KEY',
        deleted: null,
        ...(wanted ? { provider: wanted } : {}),
      },
    });

    const row = rows.length === 1 ? rows[0] : null;

    if (!row) {
      return null;
    }

    return {
      provider: row.provider,
      secret: open({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.tag,
      }),
      baseUrl: row.baseUrl,
    };
  }

  /** Which providers this workspace holds a key for. */
  async providers(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.workspaceCredential.findMany({
      where: { workspaceId, kind: 'MODEL_API_KEY', deleted: null },
      select: { provider: true },
      orderBy: { provider: 'asc' },
    });

    return rows.map((row) => row.provider);
  }

  /**
   * The plaintext secret, for the executor only.
   *
   * Deliberately not reachable from any controller. Everything that calls this
   * is server-side and must keep the value out of anything a guest can read —
   * which for the git token means never passing it in at all.
   */
  async reveal(
    workspaceId: string,
    kind: CredentialKind,
  ): Promise<{ secret: string; baseUrl: string | null } | null> {
    const row = await this.prisma.workspaceCredential.findFirst({
      where: { workspaceId, kind, deleted: null },
    });

    if (!row) {
      return null;
    }

    return {
      secret: open({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.tag,
      }),
      baseUrl: row.baseUrl,
    };
  }
}

/** Where a workspace's model access comes from, and nothing secret. */
export type ModelAccess = { source: 'workspace' } | { source: 'none' };

/**
 * A model key with everything needed to use it.
 *
 * The provider travels with the secret on purpose. Which environment variable
 * the harness reads it from, which host the sandbox may reach, and which
 * `--provider` Pi is told to use are all answered by it, and a secret handed
 * over without it is a secret nothing can spend.
 */
export interface ModelCredential {
  provider: string;
  secret: string;
  baseUrl: string | null;
}

/**
 * The key everything here is encrypted under.
 *
 * Derived from a server secret rather than used raw, so the secret does not
 * have to be exactly 32 bytes and a short one is stretched rather than
 * silently rejected. Falling back to the database URL is deliberate: a
 * self-hosted install that has set nothing still gets encryption at rest tied
 * to something deployment-specific, rather than a hardcoded constant that
 * would be worse than nothing.
 */
function encryptionKey(): Buffer {
  const secret =
    process.env.CREDENTIAL_ENCRYPTION_KEY ??
    process.env.SUPERTOKEN_CONNECTION_URI ??
    process.env.DATABASE_URL;

  if (!secret) {
    throw new Error(
      'No CREDENTIAL_ENCRYPTION_KEY is configured, and no fallback is available.',
    );
  }

  return scryptSync(secret, 'vantik-workspace-credential', 32);
}

function seal(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);

  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]).toString('hex');

  return {
    ciphertext,
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

function open(sealed: {
  ciphertext: string;
  nonce: string;
  tag: string;
}): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(sealed.nonce, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The masked handle.
 *
 * Four characters, and only when the secret is long enough that four cannot
 * reconstruct it. A short secret gets nothing back — a "hint" that is most of
 * the value is not a hint.
 */
function hintFor(secret: string): string {
  return secret.length >= 12 ? `…${secret.slice(-4)}` : '…';
}
