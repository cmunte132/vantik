import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';

import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { PasskeyChallengeOperation, Prisma } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import * as cookie from 'cookie';
import { CookieOptions, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { smtpConfigured } from 'common/smtp';

import { AuthSessionClaims, AuthSessionContext, createAuthSessionContext } from './auth.interface';

export const SESSION_COOKIE_NAME = 'sSessionToken';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CODE_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes
export const PASSKEY_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A 6-digit login code. It is a credential, so it comes from the CSPRNG. */
export function generateLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * The session token in the cookie of a request or a websocket handshake.
 * `cookies` is set only when the cookie-parser middleware ran.
 */
export function sessionTokenFromRequest(request: {
  cookies?: Record<string, string>;
  headers?: { cookie?: string | string[] };
}): string | undefined {
  const parsed = request.cookies?.[SESSION_COOKIE_NAME];
  if (parsed) {
    return parsed;
  }
  const raw = request.headers?.cookie;
  if (!raw) {
    return undefined;
  }
  return cookie.parse(Array.isArray(raw) ? raw.join('; ') : raw)[
    SESSION_COOKIE_NAME
  ];
}

@Injectable()
export class AuthService {
  /** The middleware and AuthGuard share one lookup and renewal per request. */
  private readonly requestSessions = new WeakMap<
    object,
    {
      token: string;
      session: Promise<AuthSessionContext | null>;
      renewal?: Promise<AuthSessionContext | null>;
    }
  >();
  private readonly sessionExpiries = new WeakMap<AuthSessionContext, Date>();
  readonly sessionEvents = new EventEmitter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
  ) {}

  /** This method resolves the session token of each request once. */
  async resolveRequestSession(
    request: object,
    token: string,
    res?: Response,
  ): Promise<AuthSessionContext | null> {
    let cached = this.requestSessions.get(request);
    if (cached?.token !== token) {
      cached = { token, session: this.resolveSession(token) };
      this.requestSessions.set(request, cached);
    }
    const context = await cached.session;
    if (cached.renewal) {
      return cached.renewal;
    }
    if (!res || !context) {
      return context;
    }
    const expiresAt = this.sessionExpiries.get(context);
    const now = new Date();
    if (
      expiresAt &&
      expiresAt.getTime() - now.getTime() < SESSION_MAX_AGE_MS / 2
    ) {
      cached.renewal = (async () => {
        const renewed = await this.prisma.session.updateMany({
          where: {
            id: context.getAccessTokenPayload().sessionId,
            expiresAt: { gt: now },
          },
          data: { expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS) },
        });
        if (renewed.count !== 1) {
          return null;
        }
        this.setSessionCookie(res, token);
        return context;
      })();
      return cached.renewal;
    }
    return context;
  }

  private isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  getCookieOptions(): CookieOptions {
    const isProd = this.isProduction();
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    };
  }

  setSessionCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE_NAME, token, this.getCookieOptions());
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, {
      ...this.getCookieOptions(),
      maxAge: 0,
    });
  }

  getRelyingPartyId(): string {
    const frontendHost = process.env.FRONTEND_HOST?.split(',')[0] || 'http://localhost:3000';
    try {
      const url = new URL(frontendHost);
      return url.hostname;
    } catch {
      return 'localhost';
    }
  }

  getExpectedOrigins(): string[] {
    const configured = (process.env.FRONTEND_HOST || 'http://localhost:3000')
      .split(',')
      .map((h) => h.trim().replace(/\/+$/, ''));
    return configured;
  }

  isPasskeySignupEnabled(): boolean {
    const raw = process.env.PASSKEY_SIGNUP_ENABLED?.trim().toLowerCase();
    if (raw === undefined || raw === '') {
      return true;
    }
    return raw === 'true' || raw === '1';
  }

  /**
   * Generates and stores a new database session, setting the cookie.
   */
  async createSession(
    userId: string,
    res: Response,
    workspaceId?: string,
    role?: string,
  ): Promise<{ token: string; context: AuthSessionContext }> {
    const token = generateToken(32);
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

    // If workspaceId is not specified, pick the user's first active workspace
    let activeWorkspaceId = workspaceId;
    let activeRole = role;
    if (!activeWorkspaceId) {
      const membership = await this.prisma.usersOnWorkspaces.findFirst({
        where: { userId, status: 'ACTIVE' },
        select: { workspaceId: true, role: true },
        orderBy: { createdAt: 'asc' },
      });
      if (membership) {
        activeWorkspaceId = membership.workspaceId;
        activeRole = membership.role;
      }
    }

    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        workspaceId: activeWorkspaceId,
        role: activeRole,
      },
      select: { id: true },
    });

    this.setSessionCookie(res, token);

    const claims: AuthSessionClaims = {
      appUserId: userId,
      workspaceId: activeWorkspaceId,
      role: activeRole,
      sessionId: session.id,
    };

    return {
      token,
      context: createAuthSessionContext(claims),
    };
  }

  /** This method looks up a session without a change to its expiry. */
  async resolveSession(token: string): Promise<AuthSessionContext | null> {
    const tokenHash = sha256Hex(token);
    const now = new Date();

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            usersOnWorkspaces: {
              where: { status: 'ACTIVE' },
              orderBy: { createdAt: 'asc' },
              select: { workspaceId: true, role: true },
            },
          },
        },
      },
    });

    if (!session || session.expiresAt <= now) {
      if (session) {
        await this.prisma.session.deleteMany({
          where: { id: session.id, expiresAt: { lte: now } },
        });
      }
      return null;
    }

    // Ensure session workspace is still valid for this user
    let workspaceId = session.workspaceId;
    let role = session.role;
    if (workspaceId) {
      const match = session.user.usersOnWorkspaces.find(
        (m) => m.workspaceId === workspaceId,
      );
      if (match) {
        role = match.role;
      } else {
        workspaceId = session.user.usersOnWorkspaces[0]?.workspaceId ?? null;
        role = session.user.usersOnWorkspaces[0]?.role ?? null;
      }
    } else if (session.user.usersOnWorkspaces.length > 0) {
      workspaceId = session.user.usersOnWorkspaces[0].workspaceId;
      role = session.user.usersOnWorkspaces[0].role;
    }

    const claims: AuthSessionClaims = {
      appUserId: session.userId,
      workspaceId: workspaceId ?? undefined,
      role: role ?? undefined,
      sessionId: session.id,
    };

    const context = createAuthSessionContext(claims);
    this.sessionExpiries.set(context, session.expiresAt);
    return context;
  }

  /**
   * Moves one session to a workspace. The token stays the same, so the client
   * keeps its cookie or bearer token.
   */
  async updateSessionWorkspace(
    sessionId: string,
    workspaceId: string,
    role: string,
  ): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { workspaceId, role },
    });
    this.sessionEvents.emit('session-invalidated', sessionId);
  }

  /**
   * Revokes session by token.
   */
  async revokeSession(token: string): Promise<void> {
    const tokenHash = sha256Hex(token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      select: { id: true },
    });
    const deleted = await this.prisma.session.deleteMany({
      where: { tokenHash },
    });
    if (session && deleted.count === 1) {
      this.sessionEvents.emit('session-invalidated', session.id);
    }
  }

  /**
   * Creates an email sign-in code and magic link.
   */
  async createEmailCode(email: string): Promise<{
    deviceId: string;
    preAuthSessionId: string;
    code: string;
    linkToken: string;
    magicLink: string;
  }> {
    const normalizedEmail = email.trim().toLowerCase();
    const code = generateLoginCode();
    const linkToken = generateToken(32);
    const preAuthSessionId = generateToken(24);
    const deviceId = generateToken(24);

    const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
    const codeHash = sha256Hex(code);
    const linkTokenHash = sha256Hex(linkToken);

    await this.prisma.emailVerification.create({
      data: {
        id: preAuthSessionId,
        email: normalizedEmail,
        codeHash,
        linkTokenHash,
        expiresAt,
      },
    });

    const frontendHost = process.env.FRONTEND_HOST?.split(',')[0] || 'http://localhost:3000';
    const magicLink = `${frontendHost}/auth/verify?preAuthSessionId=${preAuthSessionId}#${linkToken}`;

    // The development server writes the login code and link to its log.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`##### sendEmail to ${normalizedEmail}, subject: Login email\n\nEnter this login code in the app:\n${code}\n\nOr click here to log in with this magic link:\n${magicLink}\n\n`);
    }

    if (smtpConfigured()) {
      try {
        await this.mailerService.sendMail({
          to: normalizedEmail,
          subject: 'Login for Vantik',
          template: 'loginUser',
          context: {
            userName: normalizedEmail.split('@')[0],
            magicLink,
            loginCode: code,
            linkExpiresIn: Math.floor(CODE_LIFETIME_MS / 60000),
          },
        });
      } catch (error) {
        console.error('Failed to send auth email:', error);
        throw new ServiceUnavailableException('Could not send the login email. Please try again.');
      }
    } else if (this.isProduction()) {
      throw new ServiceUnavailableException('Email sign-in needs an SMTP server.');
    }

    return {
      deviceId,
      preAuthSessionId,
      code,
      linkToken,
      magicLink,
    };
  }

  /**
   * Consumes an email code.
   */
  async consumeEmailCode(
    preAuthSessionId: string,
    userInputCode: string,
    res: Response,
  ): Promise<{ status: 'OK' | 'INCORRECT_USER_INPUT_CODE_ERROR' | 'RESTART_FLOW_ERROR'; maximumCodeInputAttempts?: number; failedCodeInputAttemptCount?: number; user?: { id: string; email: string } }> {
    const [verification] = await this.prisma.emailVerification.updateManyAndReturn({
      where: {
        id: preAuthSessionId,
        expiresAt: { gt: new Date() },
        attempts: { lt: 5 },
      },
      data: { attempts: { increment: 1 } },
    });
    if (!verification) {
      return { status: 'RESTART_FLOW_ERROR' };
    }

    const inputHash = sha256Hex(userInputCode.trim());
    if (!verification.codeHash || !constantTimeCompare(verification.codeHash, inputHash)) {
      return {
        status: 'INCORRECT_USER_INPUT_CODE_ERROR',
        maximumCodeInputAttempts: 5,
        failedCodeInputAttemptCount: verification.attempts,
      };
    }

    const consumed = await this.prisma.emailVerification.deleteMany({
      where: { id: preAuthSessionId, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) {
      return { status: 'RESTART_FLOW_ERROR' };
    }

    // Upsert user
    const user = await this.upsertUser(verification.email);
    await this.createSession(user.id, res);

    return { status: 'OK', user };
  }

  /**
   * Consumes a magic link token.
   */
  async consumeMagicLink(
    preAuthSessionId: string,
    linkToken: string,
    res: Response,
  ): Promise<{ status: 'OK' | 'RESTART_FLOW_ERROR'; user?: { id: string; email: string } }> {
    const verification = await this.prisma.emailVerification.findUnique({
      where: { id: preAuthSessionId },
    });

    if (!verification || verification.expiresAt <= new Date()) {
      return { status: 'RESTART_FLOW_ERROR' };
    }

    const tokenHash = sha256Hex(linkToken.trim());
    if (!verification.linkTokenHash || !constantTimeCompare(verification.linkTokenHash, tokenHash)) {
      return { status: 'RESTART_FLOW_ERROR' };
    }

    const consumed = await this.prisma.emailVerification.deleteMany({
      where: { id: preAuthSessionId, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) {
      return { status: 'RESTART_FLOW_ERROR' };
    }

    const user = await this.upsertUser(verification.email);
    await this.createSession(user.id, res);

    return { status: 'OK', user };
  }

  /**
   * Generates a magic link URL for invites without sending standard login email.
   */
  async createInviteMagicLink(email: string): Promise<string> {
    const normalizedEmail = email.trim().toLowerCase();
    const linkToken = generateToken(32);
    const preAuthSessionId = generateToken(24);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days for invites
    const linkTokenHash = sha256Hex(linkToken);

    await this.prisma.emailVerification.create({
      data: {
        id: preAuthSessionId,
        email: normalizedEmail,
        linkTokenHash,
        expiresAt,
      },
    });

    const frontendHost = process.env.FRONTEND_HOST?.split(',')[0] || 'http://localhost:3000';
    return `${frontendHost}/auth/verify?preAuthSessionId=${preAuthSessionId}#${linkToken}`;
  }

  /**
   * Upserts a user for email.
   */
  async upsertUser(email: string, fullname?: string): Promise<{ id: string; email: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.upsert({
      where: { email: normalizedEmail },
      create: {
        email: normalizedEmail,
        fullname: fullname ?? normalizedEmail.split('@')[0],
        username: normalizedEmail.split('@')[0],
      },
      update: {},
      select: { id: true, email: true },
    });
    return user;
  }

  // --- WebAuthn / Passkeys ---

  private async getPasskeyRegistrationIdentity(identity: {
    userId?: string;
    email?: string;
  }): Promise<{ user: { id: string; email: string }; operation: PasskeyChallengeOperation }> {
    if (identity.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: identity.userId },
        select: { id: true, email: true },
      });
      if (!user) {
        throw new BadRequestException('User not found');
      }
      return { user, operation: PasskeyChallengeOperation.REGISTER };
    }
    if (!this.isPasskeySignupEnabled()) {
      throw new BadRequestException('Passkey signup is disabled');
    }
    const email = identity.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new BadRequestException('Sign in before you add a passkey to this account');
    }
    return {
      user: { id: randomUUID(), email },
      operation: PasskeyChallengeOperation.SIGNUP,
    };
  }

  private async claimPasskeyChallenge(
    challenge: string,
    operation: PasskeyChallengeOperation,
    identity?: { userId?: string; email?: string },
  ) {
    const stored = await this.prisma.passkeyChallenge.findUnique({
      where: { challenge },
    });
    if (!stored || stored.operation !== operation ||
      (identity?.userId && stored.userId !== identity.userId) ||
      (identity?.email && stored.email !== identity.email)) {
      throw new BadRequestException('Invalid or expired passkey challenge');
    }
    const claimed = await this.prisma.passkeyChallenge.deleteMany({
      where: { challenge, operation, expiresAt: { gt: new Date() } },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('Invalid or expired passkey challenge');
    }
    return stored;
  }

  /**
   * The server stores the challenge and the identity for each registration.
   */
  async generatePasskeyRegistrationOptions(identity: { userId?: string; email?: string }) {
    const { user, operation } = await this.getPasskeyRegistrationIdentity(identity);
    const rpID = this.getRelyingPartyId();
    const existingCredentials = operation === PasskeyChallengeOperation.REGISTER
      ? await this.prisma.passkeyCredential.findMany({
        where: { userId: user.id },
        select: { id: true, transports: true },
      })
      : [];

    const options = await generateRegistrationOptions({
      rpName: 'Vantik',
      rpID,
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((c) => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? (c.transports as Array<'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'>) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    await this.prisma.passkeyChallenge.create({
      data: {
        challenge: options.challenge,
        operation,
        userId: user.id,
        email: operation === PasskeyChallengeOperation.SIGNUP ? user.email : null,
        expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_LIFETIME_MS),
      },
    });
    return { options, user };
  }

  /**
   * The server claims the challenge before it verifies and saves the credential.
   */
  async verifyPasskeyRegistration(
    identity: { userId?: string; email?: string },
    currentChallenge: string,
    response: Parameters<typeof verifyRegistrationResponse>[0]['response'],
    res: Response,
  ): Promise<VerifiedRegistrationResponse> {
    const { user, operation } = await this.getPasskeyRegistrationIdentity(identity);
    const stored = await this.claimPasskeyChallenge(
      currentChallenge,
      operation,
      operation === PasskeyChallengeOperation.REGISTER
        ? { userId: user.id }
        : { email: user.email },
    );
    const rpID = this.getRelyingPartyId();
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.getExpectedOrigins(),
      expectedRPID: rpID,
    }).catch((cause: unknown) => {
      throw new BadRequestException('Invalid passkey registration response', { cause });
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential } = verification.registrationInfo;
      const userId = stored.userId!;
      try {
        await this.prisma.$transaction(async (tx) => {
          if (operation === PasskeyChallengeOperation.SIGNUP) {
            await tx.user.create({
              data: {
                id: userId,
                email: stored.email!,
                fullname: stored.email!.split('@')[0],
                username: stored.email!.split('@')[0],
              },
            });
          }
          await tx.passkeyCredential.create({
            data: {
              id: credential.id,
              userId,
              publicKey: Buffer.from(credential.publicKey),
              counter: BigInt(credential.counter),
              transports: credential.transports || [],
              rpId: rpID,
            },
          });
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BadRequestException('The account or passkey already exists');
        }
        throw error;
      }
      if (operation === PasskeyChallengeOperation.SIGNUP) {
        await this.createSession(userId, res);
      }
    }
    return verification;
  }

  /**
   * Generates passkey authentication options.
   */
  async generatePasskeyAuthenticationOptions(email?: string) {
    const rpID = this.getRelyingPartyId();
    let allowCredentials: Array<{ id: string; transports?: Array<'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'> }> | undefined;

    if (email) {
      const normalizedEmail = email.trim().toLowerCase();
      const user = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      if (user) {
        const credentials = await this.prisma.passkeyCredential.findMany({
          where: { userId: user.id },
          select: { id: true, transports: true },
        });
        allowCredentials = credentials.map((c) => ({
          id: c.id,
          transports: Array.isArray(c.transports) ? (c.transports as Array<'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'>) : undefined,
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    await this.prisma.passkeyChallenge.create({
      data: {
        challenge: options.challenge,
        operation: PasskeyChallengeOperation.SIGNIN,
        email: email?.trim().toLowerCase() || null,
        expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_LIFETIME_MS),
      },
    });
    return options;
  }

  /**
   * Verifies passkey authentication and issues session.
   */
  async verifyPasskeyAuthentication(
    currentChallenge: string,
    response: Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    res: Response,
  ): Promise<{ verified: boolean; user?: unknown }> {
    const stored = await this.claimPasskeyChallenge(
      currentChallenge,
      PasskeyChallengeOperation.SIGNIN,
    );
    const credentialId = response.id;
    const credential = await this.prisma.passkeyCredential.findUnique({
      where: { id: credentialId },
      include: { user: true },
    });

    if (!credential || (stored.email && credential.user.email !== stored.email)) {
      throw new BadRequestException('Passkey not found');
    }

    const rpID = this.getRelyingPartyId();
    const expectedOrigins = this.getExpectedOrigins();

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: Array.isArray(credential.transports) ? (credential.transports as Array<'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'>) : undefined,
      },
    }).catch((cause: unknown) => {
      throw new BadRequestException('Invalid passkey authentication response', { cause });
    });

    if (verification.verified) {
      await this.prisma.passkeyCredential.update({
        where: { id: credential.id },
        data: { counter: BigInt(verification.authenticationInfo.newCounter) },
      });

      await this.createSession(credential.userId, res);

      return { verified: true, user: credential.user };
    }

    return { verified: false };
  }

  /**
   * Lists passkeys for a user.
   */
  async listPasskeys(userId: string) {
    const credentials = await this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: {
        id: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return credentials.map((c) => ({
      webauthnCredentialId: c.id,
      createdAt: c.createdAt.getTime(),
    }));
  }

  /**
   * Removes a passkey for a user.
   */
  async removePasskey(userId: string, credentialId: string): Promise<boolean> {
    const result = await this.prisma.passkeyCredential.deleteMany({
      where: { id: credentialId, userId },
    });
    return result.count > 0;
  }
}
