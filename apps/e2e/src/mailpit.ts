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

  const code = message.HTML.match(
    /<span class="code">\s*([^<\s]+)\s*<\/span>/,
  )?.[1];
  const magicLink = message.HTML.match(
    /<a href="([^"]+)" class="button">/,
  )?.[1];

  expect(code, 'the login email carries no code').toBeTruthy();
  expect(magicLink, 'the login email carries no magic link').toBeTruthy();

  return {
    subject: message.Subject,
    code: decodeEntities(code!),
    magicLink: decodeEntities(magicLink!),
  };
}

/**
 * Handlebars HTML-escapes every `{{value}}`, and that includes the `=` and `&`
 * of the link's query string, so the href has to be decoded before it is a URL.
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
