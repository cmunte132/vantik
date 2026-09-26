import { expect, type APIRequestContext } from '@playwright/test';

import { MAILPIT_URL } from './env';

interface MailpitSummary {
  ID: string;
  Subject: string;
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

/** Every message Mailpit holds for `email`, newest first. */
async function messagesTo(
  request: APIRequestContext,
  email: string,
): Promise<MailpitSummary[]> {
  const response = await request.get(`${MAILPIT_URL}/api/v1/search`, {
    params: { query: `to:"${email}"`, limit: 50 },
  });
  expect(response, 'Mailpit search failed').toBeOK();

  const { messages } = (await response.json()) as {
    messages: MailpitSummary[];
  };

  // A search term is a substring match, so the address is checked exactly.
  return messages.filter((message) =>
    message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
  );
}

/** The ids of every message Mailpit holds for `email`, newest first. */
export async function messageIdsTo(
  request: APIRequestContext,
  email: string,
): Promise<string[]> {
  return (await messagesTo(request, email)).map((message) => message.ID);
}

export interface Email {
  subject: string;
  html: string;
}

/**
 * Waits for an email to `email` whose subject matches, and that is not one of
 * `alreadySeen`. Taking the ids from before the action that sends it, rather
 * than a timestamp, keeps a clock that differs between the test runner and the
 * mail container from picking up an older message.
 */
export async function readEmail(
  request: APIRequestContext,
  email: string,
  subject: RegExp,
  alreadySeen: string[] = [],
  timeout = 30_000,
): Promise<Email> {
  let id: string | undefined;

  await expect
    .poll(
      async () => {
        id = (await messagesTo(request, email)).find(
          (message) =>
            !alreadySeen.includes(message.ID) && subject.test(message.Subject),
        )?.ID;
        return id !== undefined;
      },
      {
        message: `no email with a subject like ${subject} reached Mailpit for ${email}`,
        timeout,
      },
    )
    .toBe(true);

  const response = await request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
  expect(response, 'Mailpit message fetch failed').toBeOK();
  const message = (await response.json()) as MailpitMessage;

  return { subject: message.Subject, html: message.HTML };
}

/**
 * Waits for a login email to `email` that is not one of `alreadySeen`, and
 * pulls the code and the magic link out of it.
 */
export async function readLoginEmail(
  request: APIRequestContext,
  email: string,
  alreadySeen: string[],
): Promise<LoginEmail> {
  // Whatever arrives first: nothing else is sent to the address between the
  // request for a code and this read.
  const message = await readEmail(request, email, /.*/, alreadySeen);

  // The mailer inlines the template's CSS before sending, which rewrites each
  // tag with a style attribute and reorders what was there. So a tag is found
  // by its class, and its attributes are read wherever they ended up.
  const code = message.html.match(
    /<span\b[^>]*\bclass="code"[^>]*>\s*([^<\s]+)\s*<\/span>/,
  )?.[1];
  const button = message.html.match(/<a\b[^>]*\bclass="button"[^>]*>/)?.[0];
  const magicLink = button?.match(/\bhref="([^"]+)"/)?.[1];

  const excerpt = message.html.replace(/\s+/g, ' ').slice(0, 2000);
  expect(code, `the login email carries no code:\n${excerpt}`).toBeTruthy();
  expect(
    magicLink,
    `the login email carries no magic link:\n${excerpt}`,
  ).toBeTruthy();

  return {
    subject: message.subject,
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
