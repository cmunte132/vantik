/// <reference lib="es2024.promise" />

import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_LOAD_TIMEOUT_MS = 120_000;
const BATCH_SIZE = 16;
const BATCH_INTERVAL_MS = 5_000;
const MAX_DIMENSIONS = 16_000;

interface EmbeddingConfig {
  source: 'local' | 'hosted';
  model: string;
  baseUrl: string | null;
  apiKey: string | undefined;
  identity: string;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
}

interface PendingDocument {
  id: string;
  title: string;
  body: string;
  comments: string;
  contentHash: string;
  embeddedHash: string | null;
  embeddingModel: string | null;
}

interface LocalRuntime {
  worker: Worker;
  ready: Promise<void>;
  rejectReady: (error: Error) => void;
  termination?: Promise<number>;
  loadTimer: NodeJS.Timeout;
  pending: Map<
    number,
    { resolve: (vector: number[] | null) => void; timer: NodeJS.Timeout }
  >;
}

function configuration(): EmbeddingConfig | null {
  const source = process.env.EMBEDDINGS_SOURCE?.trim();
  if (source !== 'local' && source !== 'hosted') return null;

  const model =
    process.env.EMBEDDINGS_MODEL?.trim() ||
    (source === 'local' ? LOCAL_MODEL : 'text-embedding-3-small');
  let baseUrl: string | null = null;
  if (source === 'hosted') {
    try {
      const url = new URL(
        process.env.EMBEDDINGS_BASE_URL?.trim() || 'https://api.openai.com/v1',
      );
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      ) {
        return null;
      }
      baseUrl = url.href.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  return {
    source,
    model,
    baseUrl,
    apiKey: process.env.EMBEDDINGS_API_KEY?.trim() || undefined,
    identity: JSON.stringify([source, baseUrl, model]),
  };
}

function validVector(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DIMENSIONS
  ) {
    return false;
  }
  let norm = 0;
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      return false;
    }
    norm += component * component;
  }
  return norm > 0 && Number.isFinite(norm);
}

// The worker keeps model downloads and CPU work off the server thread.
const LOCAL_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { pipeline } = require(workerData.transformers);
let queue = Promise.resolve();
pipeline('feature-extraction', workerData.model, {
  dtype: 'q8',
  device: 'cpu',
  session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  local_files_only: workerData.localOnly,
}).then(extractor => {
  parentPort.on('message', ({ id, text }) => {
    queue = queue.then(async () => {
      try {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        parentPort.postMessage({ id, vector: Array.from(output.data) });
      } catch {
        parentPort.postMessage({ id, vector: null });
      }
    });
  });
  parentPort.postMessage({ ready: true });
}).catch(() => parentPort.postMessage({ failed: true }));
`;

@Injectable()
export class EmbeddingsService implements OnModuleInit, OnModuleDestroy {
  private readonly config = configuration();
  private readonly logger = new LoggerService('EmbeddingsService');
  private readonly requests = new Set<AbortController>();
  private local: LocalRuntime | null = null;
  private nextRequestId = 0;
  private dimensions: number | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private batch: Promise<void> | null = null;
  private cursor = '';

  constructor(private readonly prisma: PrismaService) {}

  configuredModel(): string | null {
    return this.config?.identity ?? null;
  }

  onModuleInit(): void {
    if (this.config) this.schedule(1_000);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const request of this.requests) request.abort();
    const local = this.local;
    if (local) await this.stopLocal(local);
    await this.batch;
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    const config = this.config;
    if (!config || this.stopped || !text.trim()) return null;
    try {
      const vector =
        config.source === 'local'
          ? await this.embedLocal(text)
          : await this.embedHosted(text, config);
      if (!validVector(vector) || this.stopped) return null;
      if (config.source === 'local' && config.model === LOCAL_MODEL) {
        if (vector.length !== 384) return null;
      }
      if (this.dimensions !== null && this.dimensions !== vector.length) {
        return null;
      }
      this.dimensions = vector.length;
      return { vector, model: config.identity };
    } catch {
      return null;
    }
  }

  private async embedHosted(
    text: string,
    config: EmbeddingConfig,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: text,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('data' in result)) {
        return null;
      }
      const data = result.data;
      if (!Array.isArray(data) || data.length !== 1) return null;
      const item: unknown = data[0];
      if (
        !item ||
        typeof item !== 'object' ||
        !('index' in item) ||
        item.index !== 0 ||
        !('embedding' in item)
      ) {
        return null;
      }
      return item.embedding;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  private startLocal(): LocalRuntime {
    const config = this.config!;
    const worker = new Worker(LOCAL_WORKER, {
      eval: true,
      workerData: {
        transformers: require.resolve('@huggingface/transformers'),
        model: config.model,
        localOnly: isAbsolute(config.model) || config.model.startsWith('.'),
      },
    });
    const {
      promise: ready,
      resolve: resolveReady,
      reject: rejectReady,
    } = Promise.withResolvers<void>();
    const local: LocalRuntime = {
      worker,
      ready,
      rejectReady,
      pending: new Map(),
      loadTimer: setTimeout(() => {
        void this.stopLocal(local);
      }, LOCAL_LOAD_TIMEOUT_MS),
    };
    const fail = () => {
      void this.stopLocal(local);
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    worker.on('message', (message) => {
      if (message.ready) {
        clearTimeout(local.loadTimer);
        resolveReady();
      } else if (message.failed) {
        fail();
      } else {
        const pending = local.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        local.pending.delete(message.id);
        pending.resolve(message.vector);
      }
    });
    void ready.catch((): void => undefined);
    this.local = local;
    return local;
  }

  private async stopLocal(local: LocalRuntime): Promise<void> {
    if (local.termination) {
      await local.termination;
      return;
    }
    local.rejectReady(new Error('Local embeddings are unavailable'));
    if (this.local === local) this.local = null;
    clearTimeout(local.loadTimer);
    for (const pending of local.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    local.pending.clear();
    local.termination = local.worker.terminate();
    await local.termination;
  }

  private async embedLocal(text: string): Promise<number[] | null> {
    const local = this.local ?? this.startLocal();
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () => deadline.reject(new Error('Local model is not ready')),
      REQUEST_TIMEOUT_MS,
    );
    try {
      await Promise.race([local.ready, deadline.promise]);
    } finally {
      clearTimeout(timeout);
    }
    if (this.stopped || this.local !== local) return null;
    const id = ++this.nextRequestId;
    const { promise, resolve } = Promise.withResolvers<number[] | null>();
    const timer = setTimeout(() => {
      void this.stopLocal(local);
    }, REQUEST_TIMEOUT_MS);
    local.pending.set(id, { resolve, timer });
    local.worker.postMessage({ id, text });
    return promise;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.batch = this.embedPending();
      void this.batch.finally(() => {
        this.batch = null;
        this.schedule(BATCH_INTERVAL_MS);
      });
    }, delay);
    this.timer.unref();
  }

  private async embedPending(): Promise<void> {
    const model = this.configuredModel();
    if (!model || this.stopped) return;
    try {
      const rows = await this.prisma.$queryRaw<PendingDocument[]>`
        SELECT "id", "title", "body", "comments", "contentHash",
               "embeddedHash", "embeddingModel"
        FROM "SearchDocument"
        WHERE "id" > ${this.cursor}
          AND ("embedding" IS NULL
            OR "embeddingModel" IS DISTINCT FROM ${model}
            OR "embeddedHash" IS DISTINCT FROM "contentHash"
            OR (${this.dimensions}::integer IS NOT NULL
              AND vector_dims("embedding") IS DISTINCT FROM ${this.dimensions}::integer))
        ORDER BY "id"
        LIMIT ${BATCH_SIZE}
      `;
      if (rows.length === 0) this.cursor = '';
      for (const row of rows) {
        if (this.stopped) break;
        this.cursor = row.id;
        const result = await this.embed(
          [row.title, row.body, row.comments].join('\n\n'),
        );
        if (!result || this.stopped) break;
        const vector = `[${result.vector.join(',')}]`;
        await this.prisma.$executeRaw`
          UPDATE "SearchDocument"
          SET "embedding" = ${vector}::vector,
              "embeddingModel" = ${result.model},
              "embeddedHash" = ${row.contentHash}
          WHERE "id" = ${row.id}
            AND "contentHash" = ${row.contentHash}
            AND "embeddingModel" IS NOT DISTINCT FROM ${row.embeddingModel}
            AND "embeddedHash" IS NOT DISTINCT FROM ${row.embeddedHash}
        `;
      }
    } catch (error) {
      this.logger.error({
        message: 'Unable to update pending search embeddings',
        where: 'EmbeddingsService.embedPending',
        error,
      });
    }
  }
}
