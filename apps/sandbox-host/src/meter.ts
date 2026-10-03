import type { HttpHooks, HttpIpAllowInfo } from "@earendil-works/gondolin";
import type { MeteredModelCall, SandboxHostModelCalls } from "@vantikhq/types";
import type { LookupAddress, LookupOptions } from "node:dns";

import dns from "node:dns";
import { isIP } from "node:net";

import { Agent, Response, fetch as undiciFetch } from "undici";

import { log } from "./log";
import { UsageReader } from "./usage";

/**
 * The guest's egress fetch, with a meter on the model provider's hosts.
 *
 * Gondolin hands every request the guest makes to one `fetch`. This one sends
 * it as Gondolin's own would, and for a response from a metered host it copies
 * the bytes to a {@link UsageReader} as they pass, so the provider's own usage
 * (and, from a gateway, its cost) is recorded without the guest being able to
 * touch the record or the stream being held back. The guest still gets every
 * byte, as soon as it arrives.
 *
 * Passing a fetch turns off Gondolin's guarded connection, the one that checks
 * the address a host resolves to at connect time and so closes the gap between
 * its policy check and the connect. So that guard is rebuilt here, from the
 * same `isIpAllowed` hook, and without it this fetch refuses to connect at all.
 */
export class ModelCallMeter {
  private readonly calls: MeteredModelCall[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly dispatchers = new Map<string, Agent>();
  private seq = 0;
  private closed = false;

  constructor(
    private readonly meteredHosts: ReadonlySet<string>,
    private readonly isIpAllowed: NonNullable<HttpHooks["isIpAllowed"]>,
    private readonly lookup: LookupFunction = dns.lookup.bind(
      dns,
    ) as LookupFunction,
  ) {}

  readonly fetch: typeof undiciFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : "href" in input
          ? input.href
          : input.url,
    );
    const dispatcher = this.dispatcher(url);
    const startedAt = Date.now();
    const response = await undiciFetch(input, { ...init, dispatcher });

    if (!this.meteredHosts.has(url.hostname.toLowerCase()) || !response.body) {
      return response;
    }

    return this.meter(url.hostname, response, startedAt);
  };

  /** The calls recorded after `since`, once any still being read have ended. */
  async modelCalls(since: number): Promise<SandboxHostModelCalls> {
    // The harness has read its last response before the command ends, but the
    // reader settles a moment later, on the stream's own close.
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_WAIT_MS)),
      ]);
    }

    const calls = this.calls.filter((call) => call.seq >= since);
    return { calls, next: this.seq };
  }

  async close(): Promise<void> {
    this.closed = true;
    const dispatchers = [...this.dispatchers.values()];
    this.dispatchers.clear();
    await Promise.allSettled(dispatchers.map((agent) => agent.close()));
  }

  private meter(host: string, response: Response, startedAt: number): Response {
    const contentType = response.headers.get("content-type") ?? "";
    const reader = new UsageReader(contentType.includes("text/event-stream"));
    const source = response.body!.getReader();
    const seq = this.seq++;

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    this.inFlight.add(settled);

    let recorded = false;
    const record = () => {
      if (recorded) {
        return;
      }
      recorded = true;

      try {
        this.record({
          seq,
          host,
          status: response.status,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...reader.finish(),
        });
      } catch (error) {
        log.warn("model call meter: could not read a response's usage", {
          host,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(settled);
        settle();
      }
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read();

          if (done) {
            record();
            controller.close();
            return;
          }

          try {
            reader.push(value);
          } catch {
            // The meter must never break the stream it watches.
          }
          controller.enqueue(value);
        } catch (error) {
          record();
          controller.error(error);
        }
      },
      async cancel(reason) {
        // The guest hung up part-way. What arrived is still billed.
        record();
        await source.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private record(call: MeteredModelCall) {
    if (this.calls.length >= MAX_CALLS) {
      this.calls.shift();
    }
    this.calls.push(call);
  }

  private dispatcher(url: URL): Agent {
    if (this.closed) {
      throw new Error("the sandbox's network is closed");
    }

    const protocol = url.protocol === "https:" ? "https" : "http";
    const port = url.port ? Number(url.port) : protocol === "https" ? 443 : 80;
    const key = `${protocol}://${url.hostname}:${port}`;
    const cached = this.dispatchers.get(key);

    if (cached) {
      return cached;
    }

    const agent = new Agent({
      connect: {
        lookup: guardedLookup(
          { hostname: url.hostname, port, protocol },
          this.isIpAllowed,
          this.lookup,
        ),
      },
    });
    this.dispatchers.set(key, agent);
    return agent;
  }
}

type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * A `dns.lookup` that only ever answers with an address the policy allows, so
 * a host that resolves to something else at connect time (a DNS rebind to the
 * host's own network, say) is refused rather than reached. Mirrors Gondolin's
 * own guard, which it does not export.
 */
export function guardedLookup(
  info: Omit<HttpIpAllowInfo, "ip" | "family">,
  isIpAllowed: NonNullable<HttpHooks["isIpAllowed"]>,
  lookup: LookupFunction,
): LookupFunction {
  return (hostname, options, callback) => {
    const all = Boolean(options?.all);
    const failure: string | LookupAddress[] = all ? [] : "";

    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, failure);
        return;
      }

      void (async () => {
        const entries = (Array.isArray(addresses) ? addresses : [])
          .filter((entry) => isIP(entry.address) !== 0)
          .map((entry) => ({
            address: entry.address,
            family: (entry.family === 6 ? 6 : 4) as 4 | 6,
          }));
        const allowed: LookupAddress[] = [];

        for (const entry of entries) {
          if (
            await isIpAllowed({
              ...info,
              ip: entry.address,
              family: entry.family,
            })
          ) {
            if (!all) {
              callback(null, entry.address, entry.family);
              return;
            }
            allowed.push(entry);
          }
        }

        if (all && allowed.length > 0) {
          callback(null, allowed);
          return;
        }

        callback(
          Object.assign(new Error(`blocked by policy: ${info.hostname}`), {
            code: "EBLOCKED",
          }),
          failure,
        );
      })().catch((error: unknown) => {
        callback(error as NodeJS.ErrnoException, failure);
      });
    });
  };
}

/** How long a request for the calls waits on responses still being read. */
const IN_FLIGHT_WAIT_MS = 2_000;
/** A sandbox keeps at most this many records; a run makes a few hundred. */
const MAX_CALLS = 10_000;
