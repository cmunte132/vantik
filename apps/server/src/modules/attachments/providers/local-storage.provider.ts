import { promises as fs } from 'fs';
import { dirname, resolve, sep } from 'path';

import { Injectable } from '@nestjs/common';

import {
  StorageProvider,
  StorageUploadOptions,
  SignedUrlOptions,
} from '../storage-provider.interface';
import { signUrlToken, resolveUrlSigningSecret } from '../url-signer';

/** The default root. Compose mounts a volume here. */
export const DEFAULT_STORAGE_ROOT = '/data/attachments';

/**
 * Keeps files on a disk that the server mounts.
 *
 * A file system holds bytes and nothing else, so the content type travels in a
 * small file beside the stored file. The suffix cannot collide with a stored
 * file, because every stored path ends with an attachment identifier and its
 * original extension.
 */
const METADATA_SUFFIX = '.meta.json';

interface StoredMetadata {
  contentType: string;
  metadata?: Record<string, string>;
}

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;
  private readonly publicUrl: string;
  private readonly secret: string;

  constructor() {
    this.root = resolve(process.env.LOCAL_STORAGE_PATH || DEFAULT_STORAGE_ROOT);
    this.publicUrl = process.env.PUBLIC_ATTACHMENT_URL.replace(/\/+$/, '');
    this.secret = resolveUrlSigningSecret(this.root);
  }

  /**
   * Turns a storage path into a path on disk, and refuses any path that leaves
   * the root. Callers build paths from identifiers, but this class must hold
   * even when a caller passes something else.
   */
  private toDiskPath(filePath: string): string {
    const target = resolve(this.root, filePath);
    const rootPrefix = this.root.endsWith(sep) ? this.root : this.root + sep;

    if (target !== this.root && !target.startsWith(rootPrefix)) {
      throw new Error(`Path escapes the storage root: ${filePath}`);
    }

    return target;
  }

  async uploadFile(
    filePath: string,
    buffer: Buffer,
    options: StorageUploadOptions,
  ): Promise<void> {
    const target = this.toDiskPath(filePath);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);

    const stored: StoredMetadata = {
      contentType: options.contentType,
      metadata: options.metadata,
    };
    await fs.writeFile(
      `${target}${METADATA_SUFFIX}`,
      JSON.stringify(stored),
      'utf8',
    );
  }

  /**
   * A disk has nothing to sign against, so the URL comes back to this server.
   * The token carries the path, the action and the time it expires, and the
   * signature stops a client from changing any of them.
   */
  async getSignedUrl(
    filePath: string,
    options: SignedUrlOptions,
  ): Promise<string> {
    // Reject the path now, so a bad path fails here and not at the route.
    this.toDiskPath(filePath);

    const token = signUrlToken(
      {
        filePath,
        action: options.action,
        expires: options.expires,
        contentType: options.contentType,
        responseDisposition: options.responseDisposition,
        responseType: options.responseType,
      },
      this.secret,
    );

    return `${this.publicUrl}/v1/attachment/local/${token}`;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    return await fs.readFile(this.toDiskPath(filePath));
  }

  async deleteFile(filePath: string): Promise<void> {
    const target = this.toDiskPath(filePath);
    await fs.rm(target, { force: true });
    await fs.rm(`${target}${METADATA_SUFFIX}`, { force: true });
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.toDiskPath(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(
    filePath: string,
  ): Promise<{ size: number; contentType: string }> {
    const target = this.toDiskPath(filePath);
    const stats = await fs.stat(target);

    let contentType = 'application/octet-stream';
    try {
      const raw = await fs.readFile(`${target}${METADATA_SUFFIX}`, 'utf8');
      contentType = (JSON.parse(raw) as StoredMetadata).contentType;
    } catch {
      // A file written before this backend, or one written directly to the
      // volume, has no companion file. The default type is correct for it.
    }

    return { size: stats.size, contentType };
  }

  /** The route that verifies a signed URL needs the secret that made it. */
  getSecret(): string {
    return this.secret;
  }
}
