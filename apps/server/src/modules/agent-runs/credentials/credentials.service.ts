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
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { providerById } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

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
export class CredentialsService implements OnModuleInit {
  private readonly logger = new LoggerService(CredentialsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Refuses to start without a key, then moves old credentials onto it.
   *
   * The check is here rather than at the first save, because the first save
   * can be weeks after a deploy, and by then nobody connects the failure to
   * the variable they never set.
   */
  async onModuleInit() {
    // Outside the try on purpose. Every other failure here is survivable; a
    // server with no key would take credentials it can never seal.
    currentKey();

    try {
      await this.resealLegacyCredentials();
    } catch (error) {
      // Nothing is lost by waiting: a row the re-seal did not reach is still
      // readable under the old key, and the next start tries again.
      this.logger.error({
        message: `Moving credentials onto CREDENTIAL_ENCRYPTION_KEY failed: ${error}`,
        where: 'CredentialsService.onModuleInit',
      });
    }
  }

  /**
   * Re-seals every credential that an old fallback key opens.
   *
   * Before the key was required, a server without one sealed credentials under
   * SUPERTOKEN_CONNECTION_URI. That is not a secret: the compose file sets it
   * to `http://supertokens:3567`, so every default install used a key anyone
   * could read. Requiring a real key fixes new rows; this moves the old ones,
   * so that turning the key on does not make a workspace enter its keys again.
   *
   * Soft-deleted rows are moved too. They still hold the secret somebody
   * removed, and it should not stay under a public key.
   */
  async resealLegacyCredentials(): Promise<{
    resealed: number;
    unreadable: number;
  }> {
    const rows = await this.prisma.workspaceCredential.findMany({
      select: {
        id: true,
        ciphertext: true,
        nonce: true,
        tag: true,
        deleted: true,
      },
    });

    const current = currentKey();
    const legacy = legacyKeys();
    let resealed = 0;
    let unreadable = 0;

    for (const row of rows) {
      if (tryOpen(row, current) !== null) {
        continue;
      }

      const secret = legacy
        .map((key) => tryOpen(row, key))
        .find((opened) => opened !== null);

      if (secret === undefined) {
        // A removed credential nobody can open is not worth a warning.
        unreadable += row.deleted ? 0 : 1;
        continue;
      }

      // Conditional on the ciphertext that was read, so a key saved from the
      // settings screen in the meantime is not overwritten with the old one.
      const { count } = await this.prisma.workspaceCredential.updateMany({
        where: { id: row.id, ciphertext: row.ciphertext },
        data: seal(secret, current),
      });
      resealed += count;
    }

    if (resealed > 0) {
      this.logger.info({
        message: `Re-sealed ${resealed} workspace credentials under CREDENTIAL_ENCRYPTION_KEY.`,
        where: 'CredentialsService.resealLegacyCredentials',
      });
    }

    if (unreadable > 0) {
      this.logger.warn({
        message: `${unreadable} workspace credentials cannot be opened with CREDENTIAL_ENCRYPTION_KEY or any old fallback. Agent runs in those workspaces will fail until an admin saves the key again in agent settings.`,
        where: 'CredentialsService.resealLegacyCredentials',
      });
    }

    return { resealed, unreadable };
  }

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

/** Enough that a guessed or reused value is not a real risk. */
const MIN_KEY_LENGTH = 32;

/**
 * The shipped defaults of SUPERTOKEN_CONNECTION_URI, for the compose file and
 * for a server run on the host. A server that set no key sealed under
 * whichever one it was started with, and an install may since have moved from
 * one to the other.
 */
const LEGACY_DEFAULTS = ['http://supertokens:3567', 'http://localhost:3567'];

const derived = new Map<string, Buffer>();

/**
 * Stretches a secret into an AES-256 key.
 *
 * Derived rather than used raw, so the secret does not have to be exactly 32
 * bytes. Cached because scrypt is slow on purpose, and every seal and open
 * needs the key.
 */
function derive(secret: string): Buffer {
  let key = derived.get(secret);

  if (!key) {
    key = scryptSync(secret, 'vantik-workspace-credential', 32);
    derived.set(secret, key);
  }

  return key;
}

/**
 * The key everything here is encrypted under.
 *
 * It must be set. It once fell back to SUPERTOKEN_CONNECTION_URI and then to
 * DATABASE_URL, so that an install with no key still had encryption at rest.
 * But the first of those is a public constant in a default install, so the
 * encryption protected nothing.
 */
function currentKey(): Buffer {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();

  if (!secret) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. It encrypts the model keys and git tokens that agent runs use, and the server does not start without it. Make one with `openssl rand -base64 32` and add it to .env.',
    );
  }

  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY has ${secret.length} characters, and it needs at least ${MIN_KEY_LENGTH}. Make one with \`openssl rand -base64 32\`.`,
    );
  }

  return derive(secret);
}

/** Every key a credential may have been sealed under before one was required. */
function legacyKeys(): Buffer[] {
  const secrets = [
    process.env.SUPERTOKEN_CONNECTION_URI,
    process.env.DATABASE_URL,
    ...LEGACY_DEFAULTS,
  ].filter((secret): secret is string => Boolean(secret));

  return [...new Set(secrets)].map(derive);
}

function seal(value: string, key = currentKey()) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

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

interface Sealed {
  ciphertext: string;
  nonce: string;
  tag: string;
}

function open(sealed: Sealed, key = currentKey()): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(sealed.nonce, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** The plaintext, or null when this key did not seal it. */
function tryOpen(sealed: Sealed, key: Buffer): string | null {
  try {
    return open(sealed, key);
  } catch {
    return null;
  }
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
