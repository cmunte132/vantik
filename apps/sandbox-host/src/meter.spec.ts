import type { AddressInfo } from "node:net";

import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelCallMeter, guardedLookup } from "./meter";

describe("ModelCallMeter", () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = createServer((request, response) => {
      if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [{ delta: { content: "a" } }] })}\n\n`,
        );
        setTimeout(() => {
          response.end(
            `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.25 } })}\n\ndata: [DONE]\n\n`,
          );
        }, 20);
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await close();
  });

  it("passes the stream through whole and records the provider's usage", async () => {
    const meter = new ModelCallMeter(new Set(["localhost"]), () => true);

    const response = await meter.fetch(`${base}/stream`);
    const text = await response.text();

    expect(text).toContain("[DONE]");
    expect(text).toContain('"content":"a"');

    const { calls, next } = await meter.modelCalls(0);
    expect(next).toBe(1);
    expect(calls).toEqual([
      expect.objectContaining({
        seq: 0,
        host: "localhost",
        status: 200,
        api: "openai-chat",
        responseId: "gen-1",
        usage: { input: 10, output: 2 },
        costUsd: 0.25,
      }),
    ]);
    expect((await meter.modelCalls(1)).calls).toEqual([]);

    await meter.close();
  });

  it("waits for a response still being read before answering", async () => {
    const meter = new ModelCallMeter(new Set(["localhost"]), () => true);

    const response = await meter.fetch(`${base}/stream`);
    const reading = response.text();
    const { calls } = await meter.modelCalls(0);
    await reading;

    expect(calls).toHaveLength(1);
    expect(calls[0].costUsd).toBe(0.25);

    await meter.close();
  });

  it("leaves a host that is not a model provider alone", async () => {
    const meter = new ModelCallMeter(new Set(["openrouter.ai"]), () => true);

    const response = await meter.fetch(`${base}/plain`);
    expect(await response.json()).toEqual({ ok: true });
    expect((await meter.modelCalls(0)).calls).toEqual([]);

    await meter.close();
  });

  it("refuses to connect to an address the policy does not allow", async () => {
    const meter = new ModelCallMeter(new Set(["localhost"]), () => false);

    await expect(meter.fetch(`${base}/stream`)).rejects.toThrow();
    expect((await meter.modelCalls(0)).calls).toEqual([]);

    await meter.close();
  });
});

describe("guardedLookup", () => {
  interface Address {
    address: string;
    family: number;
  }
  const resolver =
    (addresses: Address[]) =>
    (
      _hostname: string,
      _options: unknown,
      callback: (error: null, found: Address[]) => void,
    ) =>
      callback(null, addresses);

  it("answers with the first allowed address, skipping the rest", async () => {
    const lookup = guardedLookup(
      { hostname: "example.com", port: 443, protocol: "https" },
      ({ ip }) => ip !== "10.0.0.1",
      resolver([
        { address: "10.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]),
    );

    const answer = await new Promise((resolve, reject) =>
      lookup("example.com", {}, (error, address, family) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );

    expect(answer).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a host whose every address is blocked", async () => {
    const lookup = guardedLookup(
      { hostname: "rebind.test", port: 443, protocol: "https" },
      () => false,
      resolver([{ address: "127.0.0.1", family: 4 }]),
    );

    await expect(
      new Promise((resolve, reject) =>
        lookup("rebind.test", { all: true }, (error, address) =>
          error ? reject(error) : resolve(address),
        ),
      ),
    ).rejects.toThrow("blocked by policy");
  });
});
