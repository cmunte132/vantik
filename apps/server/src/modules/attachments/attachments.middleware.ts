import type { RequestHandler } from 'express';

import * as bodyParser from 'body-parser';

/**
 * The path that the local storage backend puts in the URLs it signs.
 */
export const LOCAL_ATTACHMENT_PATH = '/v1/attachment/local';

/**
 * A signed upload to the local backend sends the file as raw bytes, the same
 * way a client sends one to S3. It is neither JSON nor a form, so this path
 * needs a parser that keeps the body whole.
 *
 * The application applies this, and so does the test that proves the route
 * works. Both take it from here, so the test cannot pass against a
 * configuration that the server does not use.
 */
export function localAttachmentBodyParser(): RequestHandler {
  return bodyParser.raw({ type: '*/*', limit: '50mb' });
}
