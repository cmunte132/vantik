import type { APIRequestContext } from '@playwright/test';

import type { Account } from '../../src/auth';
import { expect, test } from '../../src/fixtures';

/**
 * An image pasted into the editor takes three requests: ask the server for a
 * signed upload URL, PUT the bytes to it, then render the URL the server gave
 * back. The stack stores attachments on its own disk by default, so the signed
 * URL comes back to the server itself, through the webapp's proxy.
 */

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Uploaded {
  id: string;
  publicURL: string;
}

async function upload(api: APIRequestContext): Promise<Uploaded> {
  const signed = await api.post('/v1/attachment/get-signed-url', {
    data: {
      fileName: 'pixel.png',
      originalName: 'pixel.png',
      contentType: 'image/png',
      mimetype: 'image/png',
      size: PNG.length,
    },
  });
  expect(signed, `getting a signed URL failed: ${await signed.text()}`).toBeOK();
  const { url, attachment } = await signed.json();
  expect(url, 'the server made no upload URL').toBeTruthy();

  // Exactly what the editor does: a PUT of the raw bytes, with no session.
  const put = await api.put(url, {
    headers: { 'content-type': 'image/png' },
    data: PNG,
  });
  expect(put, `uploading to the signed URL failed: ${await put.text()}`).toBeOK();

  return attachment;
}

function inWorkspace(account: Account, attachment: Uploaded): string {
  return `/v1/attachment/${account.workspaceId}/${attachment.id}`;
}

test.describe('attachments', () => {
  test('an uploaded image can be read back from its workspace URL', async ({
    asAlice,
    alice,
  }) => {
    const attachment = await upload(asAlice);

    const read = await asAlice.get(inWorkspace(alice, attachment));

    expect(read).toBeOK();
    expect(read.headers()['content-type']).toContain('image/png');
    // A file is for the workspace's members, so no shared cache may keep it.
    expect(read.headers()['cache-control']).toMatch(/^private\b/);
    expect(await read.body()).toEqual(PNG);
  });

  test('an uploaded image can be read back from the URL the editor renders', async ({
    asAlice,
  }) => {
    const attachment = await upload(asAlice);
    // The editor renders `/api/v1/attachment/<id>` through the webapp proxy,
    // which is this route on the server.
    expect(attachment.publicURL).toMatch(new RegExp(`/v1/attachment/${attachment.id}$`));

    const read = await asAlice.get(`/v1/attachment/${attachment.id}`);

    expect(read).toBeOK();
    expect(await read.body()).toEqual(PNG);
  });

  test('an attachment needs a signed-in reader', async ({ asAlice, alice, anonymous }) => {
    const attachment = await upload(asAlice);

    expect((await anonymous.get(inWorkspace(alice, attachment))).status()).toBe(401);
  });

  test("Bob cannot read Alice's attachment", async ({ asAlice, asBob, alice }) => {
    const attachment = await upload(asAlice);
    expect(await (await asAlice.get(inWorkspace(alice, attachment))).body()).toEqual(PNG);

    // By the id alone, Bob's own workspace is searched, and it is not there.
    expect((await asBob.get(`/v1/attachment/${attachment.id}`)).ok()).toBe(false);

    const read = await asBob.get(inWorkspace(alice, attachment));

    expect([403, 404]).toContain(read.status());
  });
});
