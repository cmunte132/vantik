export interface StorageProvider {
  uploadFile(
    filePath: string,
    buffer: Buffer,
    options: StorageUploadOptions,
  ): Promise<void>;

  getSignedUrl(filePath: string, options: SignedUrlOptions): Promise<string>;

  downloadFile(filePath: string): Promise<Buffer>;

  deleteFile(filePath: string): Promise<void>;

  fileExists(filePath: string): Promise<boolean>;

  getMetadata(filePath: string): Promise<{ size: number; contentType: string }>;
}

export interface StorageUploadOptions {
  contentType: string;
  metadata?: Record<string, string>;
  resumable?: boolean;
  validation?: boolean;
}

export interface SignedUrlOptions {
  action: 'read' | 'write';
  expires: number;
  contentType?: string;
  responseDisposition?: string;
  responseType?: string;
}

/**
 * Each backend supplies one definition, and the registry holds them all. To add
 * a backend, write a definition and register it. No shared dispatch code
 * changes.
 */
export interface StorageProviderDefinition {
  /** The value of STORAGE_PROVIDER that selects this backend. */
  key: string;

  /** One line about the backend. The registry shows it when the key is wrong. */
  summary: string;

  /**
   * Other values of STORAGE_PROVIDER that select this backend. Use these to
   * keep an older name at work after a backend grows wider than that name.
   */
  aliases?: string[];

  /**
   * The environment variables that this backend must have. The registry reads
   * them before it makes the provider, and stops the server if one is empty.
   * A backend with defaults for everything gives an empty list.
   */
  requiredEnv: string[];

  /**
   * Makes the provider. The registry calls this only after the configuration
   * is complete, so a provider does not test its own environment.
   */
  create(): StorageProvider;
}

/**
 * A backend that the server no longer has. The registry gives this message
 * instead of "unknown provider", because an operator who upgrades with this
 * key in the environment needs the migration, not a list of valid keys.
 */
export interface RetiredStorageProvider {
  key: string;
  migration: string;
}
