import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

export type CredentialKind = 'MODEL_API_KEY' | 'GIT_TOKEN';

/** What the API is allowed to say about a stored secret. */
export interface CredentialHandle {
  kind: CredentialKind;
  /** `…a1b2`. Enough to tell one key from another, useless to anyone else. */
  hint: string;
  baseUrl: string | null;
  updatedAt: Date;
  rotatedAt: Date | null;
}

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
      select: {
        kind: true,
        hint: true,
        baseUrl: true,
        updatedAt: true,
        rotatedAt: true,
      },
    });

    return rows as CredentialHandle[];
  }

  /**
   * Stores or rotates a secret, and hands back only a masked handle.
   *
   * Upserts rather than appends: one credential of each kind per workspace, so
   * there is never ambiguity about which key a run used.
   */
  async put(input: {
    workspaceId: string;
    kind: CredentialKind;
    secret: string;
    baseUrl?: string;
    createdById?: string;
  }): Promise<CredentialHandle> {
    const secret = input.secret.trim();

    if (!secret) {
      throw new BadRequestException({ message: 'The secret is empty.' });
    }

    const sealed = seal(secret);
    const hint = hintFor(secret);

    const existing = await this.prisma.workspaceCredential.findFirst({
      where: { workspaceId: input.workspaceId, kind: input.kind },
      select: { id: true },
    });

    const data = {
      ...sealed,
      hint,
      baseUrl: input.baseUrl ?? null,
      deleted: null as Date | null,
      ...(existing ? { rotatedAt: new Date() } : {}),
    };

    const row = existing
      ? await this.prisma.workspaceCredential.update({
          where: { id: existing.id },
          data,
          select: {
            kind: true,
            hint: true,
            baseUrl: true,
            updatedAt: true,
            rotatedAt: true,
          },
        })
      : await this.prisma.workspaceCredential.create({
          data: {
            ...data,
            workspaceId: input.workspaceId,
            kind: input.kind,
            createdById: input.createdById,
          },
          select: {
            kind: true,
            hint: true,
            baseUrl: true,
            updatedAt: true,
            rotatedAt: true,
          },
        });

    return row as CredentialHandle;
  }

  async remove(workspaceId: string, kind: CredentialKind): Promise<void> {
    const { count } = await this.prisma.workspaceCredential.updateMany({
      where: { workspaceId, kind, deleted: null },
      data: { deleted: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException({
        message: `This workspace has no ${kind} configured.`,
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
