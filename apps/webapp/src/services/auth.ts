import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

/**
 * Checks whether the browser and device support WebAuthn / passkeys.
 */
export async function doesBrowserSupportWebAuthn(): Promise<{
  status: 'OK';
  browserSupportsWebauthn: boolean;
}> {
  const supported =
    typeof window !== 'undefined' &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === 'function';
  return { status: 'OK', browserSupportsWebauthn: supported };
}

/**
 * Initiates email sign-in/up code request.
 */
export async function createCode(input: { email: string }): Promise<{
  status: 'OK';
  deviceId: string;
  preAuthSessionId: string;
  flowType: 'USER_INPUT_CODE_AND_MAGIC_LINK';
}> {
  const res = await fetch('/api/v1/auth/signinup/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to create login code');
  }
  return await res.json();
}

/**
 * Consumes email login code.
 */
export async function consumeCode(input: {
  preAuthSessionId: string;
  userInputCode: string;
  deviceId?: string;
}): Promise<{
  status: 'OK' | 'INCORRECT_USER_INPUT_CODE_ERROR' | 'RESTART_FLOW_ERROR';
  maximumCodeInputAttempts?: number;
  failedCodeInputAttemptCount?: number;
}> {
  const res = await fetch('/api/v1/auth/signinup/code/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to verify code');
  }
  return await res.json();
}

/**
 * Consumes magic link token.
 */
export async function consumeMagicLink(input: {
  preAuthSessionId: string;
  linkCode: string;
}): Promise<{ status: 'OK' | 'RESTART_FLOW_ERROR' }> {
  const res = await fetch('/api/v1/auth/signinup/link/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to verify magic link');
  }
  return await res.json();
}


/**
 * Checks whether an active session exists on the server.
 */
export async function doesSessionExist(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/session', {
      credentials: 'include',
    });
    if (!res.ok) {
      return false;
    }
    const data = await res.json();
    return Boolean(data.authenticated);
  } catch {
    return false;
  }
}

/**
 * Signs out the current session on the server and clears cookies.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/v1/auth/signout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // ignore
  }
}

// --- Passkey / WebAuthn helpers ---

/**
 * Passkey sign-in without typing email (or with email).
 */
export async function authenticateCredentialWithSignIn(input?: {
  email?: string;
}): Promise<{ status: 'OK' | 'SIGN_IN_NOT_ALLOWED' | 'WEBAUTHN_NOT_SUPPORTED' | 'FAILED_TO_AUTHENTICATE_USER'; reason?: string }> {
  try {
    const optionsRes = await fetch('/api/v1/auth/webauthn/signin/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input?.email }),
    });
    if (!optionsRes.ok) {
      return { status: 'FAILED_TO_AUTHENTICATE_USER' };
    }
    const { options } = await optionsRes.json();

    const authResponse = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch('/api/v1/auth/webauthn/signin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ challenge: options.challenge, response: authResponse }),
    });

    if (!verifyRes.ok) {
      return { status: 'FAILED_TO_AUTHENTICATE_USER' };
    }
    const result = await verifyRes.json();
    if (result.status === 'OK') {
      return { status: 'OK' };
    }
    return { status: 'FAILED_TO_AUTHENTICATE_USER' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not supported') || message.includes('NotSupportedError')) {
      return { status: 'WEBAUTHN_NOT_SUPPORTED' };
    }
    return { status: 'FAILED_TO_AUTHENTICATE_USER' };
  }
}

/**
 * This function registers a passkey for signup or for the current account.
 */
export async function registerPasskey(input: {
  email?: string;
} = {}): Promise<{ status: 'OK' | 'SIGN_UP_NOT_ALLOWED' | 'WEBAUTHN_NOT_SUPPORTED' | 'FAILED_TO_REGISTER_USER'; reason?: string }> {
  try {
    const optionsRes = await fetch('/api/v1/auth/webauthn/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: input.email }),
    });

    const optionsData = await optionsRes.json();
    if (optionsData.status === 'SIGN_UP_NOT_ALLOWED') {
      return { status: 'SIGN_UP_NOT_ALLOWED', reason: optionsData.reason };
    }
    if (!optionsRes.ok) {
      return { status: 'FAILED_TO_REGISTER_USER' };
    }

    const { options, user } = optionsData;
    const regResponse = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch('/api/v1/auth/webauthn/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: user?.email || input.email,
        challenge: options.challenge,
        response: regResponse,
      }),
    });

    if (!verifyRes.ok) {
      return { status: 'FAILED_TO_REGISTER_USER' };
    }
    const verifyData = await verifyRes.json();
    if (verifyData.status === 'OK') {
      return { status: 'OK' };
    }
    return { status: 'FAILED_TO_REGISTER_USER' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not supported') || message.includes('NotSupportedError')) {
      return { status: 'WEBAUTHN_NOT_SUPPORTED' };
    }
    return { status: 'FAILED_TO_REGISTER_USER' };
  }
}

/**
 * List credentials registered for the current user.
 */
export async function listCredentials(): Promise<{
  status: 'OK';
  credentials: Array<{ webauthnCredentialId: string; createdAt: number }>;
}> {
  const res = await fetch('/api/v1/auth/webauthn/credentials', {
    credentials: 'include',
  });
  if (!res.ok) {
    return { status: 'OK', credentials: [] };
  }
  return await res.json();
}

/**
 * Remove a registered credential.
 */
export async function removeCredential(input: {
  webauthnCredentialId: string;
}): Promise<{ status: 'OK' | 'ERROR' }> {
  const res = await fetch(
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(input.webauthnCredentialId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
    },
  );
  if (!res.ok) {
    return { status: 'ERROR' };
  }
  return await res.json();
}
