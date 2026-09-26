import { expect, type APIRequestContext } from '@playwright/test';

import { MAILPIT_URL } from './env';

interface MailpitSummary {
  ID: string;
  To: Array<{ Address: string }>;
}

interface MailpitMessage {
  Subject: string;
  HTML: string;
}

/** What the server's login email (templates/loginUser.hbs) carries. */
export interface LoginEmail {
  subject: string;
  code: string;
  magicLink: string;
}

/** The ids of every message Mailpit holds for `email`, newest first. */
export async function messageIdsTo(
  request: APIRequestContext,
  email: string,
): Promise<string[]> {
  const response = await request.get(`${MAILPIT_URL}/api/v1/search`, {
    params: { query: `to:"${email}"`, limit: 50 },
  });
  expect(response, 'Mailpit search failed').toBeOK();

  const { messages } = (await response.json()) as {
    messages: MailpitSummary[];
  };

  // A search term is a substring match, so the address is checked exactly.
  return messages
    .filter((message) =>
      message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
    )
    .map((message) => message.ID);
}

/**
 * Waits for a login email to `email` that is not one of `alreadySeen`, and
 * pulls the code and the magic link out of it. Taking the ids from before the
 * request, rather than a timestamp, keeps a clock that differs between the
 * test runner and the mail container from picking up an older code.
 */
export async function readLoginEmail(
  request: APIRequestContext,
  email: string,
  alreadySeen: string[],
): Promise<LoginEmail> {
  let id: string | undefined;

  await expect
    .poll(
      async () => {
        const ids = await messageIdsTo(request, email);
        id = ids.find((candidate) => !alreadySeen.includes(candidate));
        return id !== undefined;
      },
      {
        message: `no login email reached Mailpit for ${email}`,
        timeout: 30_000,
      },
    )
    .toBe(true);

  const response = await request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
  expect(response, 'Mailpit message fetch failed').toBeOK();
  const message = (await response.json()) as MailpitMessage;

  // The mailer inlines the template's CSS before sending, which rewrites each
  // tag with a style attribute and reorders what was there. So a tag is found
  // by its class, and its attributes are read wherever they ended up.
  const code = message.HTML.match(
    /<span\b[^>]*\bclass="code"[^>]*>\s*([^<\s]+)\s*<\/span>/,
  )?.[1];
  const button = message.HTML.match(/<a\b[^>]*\bclass="button"[^>]*>/)?.[0];
  const magicLink = button?.match(/\bhref="([^"]+)"/)?.[1];

  const excerpt = message.HTML.replace(/\s+/g, ' ').slice(0, 2000);
  expect(code, `the login email carries no code:\n${excerpt}`).toBeTruthy();
  expect(
    magicLink,
    `the login email carries no magic link:\n${excerpt}`,
  ).toBeTruthy();

  return {
    subject: message.Subject,
    code: decodeEntities(code!),
    magicLink: decodeEntities(magicLink!),
  };
}

/**
 * The href is HTML: at least its `&` arrives escaped, and depending on what
 * last serialised the markup (Handlebars or the CSS inliner) so may its `=`.
 * It has to be decoded before it is a URL.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot);/gi, (_, entity) => {
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
    };
    const lower = entity.toLowerCase();
    if (lower in named) {
      return named[lower];
    }
    return String.fromCodePoint(
      lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10),
    );
  });
}
