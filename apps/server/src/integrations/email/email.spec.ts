import { emailSpec } from './plugin-spec';
import { emailTriage } from './triage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The email port, and the bug it was carrying.
 *
 * The original wrote every Gmail attachment to `/tmp/${attachment.filename}`
 * and read it back. Three faults in one line: a writable filesystem it never
 * declared, a collision when two messages carry the same attachment name, and a
 * path built from a name chosen by whoever sent the email.
 */
describe('the email plugin spec', () => {
  it('reaches Gmail and nowhere else', () => {
    expect(emailSpec.egress).toEqual(['gmail.googleapis.com']);
  });

  it('takes the token from the account rather than the plugin', () => {
    expect(
      emailSpec.auth?.({ integrationConfiguration: { token: 'abc' } }),
    ).toBe('Bearer abc');
    expect(emailSpec.auth?.({ integrationConfiguration: {} })).toBeUndefined();
  });
});

describe('triaging an email', () => {
  function contextWith(gmail: Record<string, Json>) {
    const uploaded: Json[] = [];

    const ctx = {
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      vendor: {
        fetch: jest.fn(async (path: string) => {
          const body = gmail[path];

          return body
            ? { ok: true, json: async () => body }
            : { ok: false, status: 404 };
        }),
      },
      attachments: {
        upload: jest.fn(async (file: Json) => {
          uploaded.push(file);

          return {
            publicURL: `https://files/${file.filename}`,
            fileType: file.contentType,
            originalName: file.filename,
            size: file.bytes.length,
          };
        }),
      },
      workspace: {
        team: jest.fn().mockResolvedValue({ id: 'team-1' }),
        workflows: jest
          .fn()
          .mockResolvedValue([{ id: 'state-1', category: 'TRIAGE' }]),
      },
      links: { bySource: jest.fn().mockResolvedValue([]) },
      issues: {
        create: jest.fn().mockResolvedValue({ id: 'issue-1' }),
        update: jest.fn().mockResolvedValue({ id: 'issue-1' }),
      },
    } as unknown as Parameters<typeof emailTriage>[0];

    return { ctx, uploaded };
  }

  const action = {
    data: { inputs: { teamMappings: [{ id: 'support', teamId: 'team-1' }] } },
  };

  const account = { integrationDefinition: { slug: 'email' } };

  /**
   * The routing rule: which team an email lands in is decided by what somebody
   * typed in the To field.
   */
  it('routes on the mapping key in the delivered-to address', async () => {
    const { ctx } = contextWith({
      '/gmail/v1/users/me/messages/m1': {
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Subject', value: 'The printer is on fire' },
            { name: 'Delivered-To', value: 'inbox+acme-support@vantik.dev' },
            { name: 'From', value: 'Ada <ada@example.com>' },
          ],
          parts: [
            {
              mimeType: 'text/html',
              body: { data: Buffer.from('<p>Help</p>').toString('base64') },
            },
          ],
        },
      },
    });

    await emailTriage(ctx, { messageId: 'm1' }, account, action);

    expect(ctx.issues.create).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ title: 'The printer is on fire' }),
    );
  });

  it('does nothing when no team is mapped to that address', async () => {
    const { ctx } = contextWith({
      '/gmail/v1/users/me/messages/m1': {
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Hello' },
            { name: 'Delivered-To', value: 'inbox+acme-nowhere@vantik.dev' },
          ],
          parts: [],
        },
      },
    });

    await emailTriage(ctx, { messageId: 'm1' }, account, action);

    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  /**
   * The fix. The plugin hands over bytes and a name; it never composes a path,
   * so a filename cannot reach the filesystem however it is spelled.
   */
  it('uploads attachment bytes without touching a path', async () => {
    const { ctx, uploaded } = contextWith({
      '/gmail/v1/users/me/messages/m1': {
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Logs' },
            { name: 'Delivered-To', value: 'inbox+acme-support@vantik.dev' },
          ],
          parts: [
            {
              mimeType: 'text/html',
              body: {
                data: Buffer.from('<p>see attached</p>').toString('base64'),
              },
            },
            {
              mimeType: 'text/plain',
              filename: '../../../etc/passwd',
              body: { attachmentId: 'a1' },
            },
          ],
        },
      },
      '/gmail/v1/users/me/messages/m1/attachments/a1': {
        data: Buffer.from('hello').toString('base64url'),
      },
    });

    await emailTriage(ctx, { messageId: 'm1' }, account, action);

    expect(uploaded).toHaveLength(1);
    // The traversal-shaped name survives as a *name*, which is harmless, and
    // never becomes part of a path.
    expect(uploaded[0].filename).toBe('../../../etc/passwd');
    expect(uploaded[0].bytes.toString()).toBe('hello');
    expect(uploaded[0]).not.toHaveProperty('path');
  });

  /** A message is a tree, not a list: multipart inside multipart is ordinary. */
  it('finds the body nested inside multipart parts', async () => {
    const { ctx } = contextWith({
      '/gmail/v1/users/me/messages/m1': {
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Nested' },
            { name: 'Delivered-To', value: 'inbox+acme-support@vantik.dev' },
          ],
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/html',
                  body: {
                    data: Buffer.from('<p>buried</p>').toString('base64'),
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await emailTriage(ctx, { messageId: 'm1' }, account, action);

    const [, created] = (ctx.issues.create as jest.Mock).mock.calls[0];
    expect(created.description).toContain('buried');
  });
});
