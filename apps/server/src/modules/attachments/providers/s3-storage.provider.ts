import {
  S3,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';

import {
  StorageProvider,
  StorageUploadOptions,
  SignedUrlOptions,
} from '../storage-provider.interface';

/**
 * Speaks the S3 protocol, to Amazon S3 or to any store that answers it.
 *
 * S3_ENDPOINT is what makes the difference. Point it at Cloudflare R2, MinIO,
 * DigitalOcean Spaces, Backblaze B2, Wasabi, or the Google Cloud Storage
 * interoperability endpoint, and this one backend serves all of them.
 *
 * Credentials are optional. When the environment holds no key pair, the AWS SDK
 * looks for credentials the usual way, which is how a server that runs with an
 * instance role gets them.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private s3: S3;
  private bucketName: string;

  constructor() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const endpoint = process.env.S3_ENDPOINT;

    this.s3 = new S3({
      region: process.env.AWS_REGION,
      ...(endpoint ? { endpoint } : {}),
      // Most stores that are not Amazon put the bucket in the path instead of
      // the host name, so path style is the right default once an endpoint is
      // set. An operator can still say otherwise.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE
        ? process.env.S3_FORCE_PATH_STYLE === 'true'
        : Boolean(endpoint),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    this.bucketName = process.env.BUCKET_NAME;
  }

  async uploadFile(
    filePath: string,
    buffer: Buffer,
    options: StorageUploadOptions,
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: filePath,
      Body: buffer,
      ContentType: options.contentType,
      Metadata: options.metadata,
    });

    await this.s3.send(command);
  }

  async getSignedUrl(
    filePath: string,
    options: SignedUrlOptions,
  ): Promise<string> {
    const command =
      options.action === 'read'
        ? new GetObjectCommand({
            Bucket: this.bucketName,
            Key: filePath,
            ResponseContentType: options.responseType,
            ResponseContentDisposition: options.responseDisposition,
          })
        : new PutObjectCommand({
            Bucket: this.bucketName,
            Key: filePath,
            ContentType: options.contentType,
          });

    return await getSignedUrl(this.s3, command, {
      expiresIn: Math.floor((options.expires - Date.now()) / 1000),
    });
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: filePath,
    });

    const response = await this.s3.send(command);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async deleteFile(filePath: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: filePath,
    });

    await this.s3.send(command);
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: filePath,
      });
      await this.s3.send(command);
      return true;
    } catch (error) {
      // Amazon answers NotFound. Some compatible stores answer 404 with a
      // different name, so the status is the reliable test.
      if (
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async getMetadata(
    filePath: string,
  ): Promise<{ size: number; contentType: string }> {
    const command = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: filePath,
    });

    const response = await this.s3.send(command);
    return {
      size: response.ContentLength,
      contentType: response.ContentType,
    };
  }
}
