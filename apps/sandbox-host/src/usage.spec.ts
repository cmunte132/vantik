import { describe, expect, it } from "vitest";

import { UsageReader } from "./usage";

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** Feeds the text in small, uneven pieces, as a network would. */
function read(text: string, streamed = true) {
  const reader = new UsageReader(streamed);
  const bytes = new TextEncoder().encode(text);

  for (let at = 0; at < bytes.length; at += 7) {
    reader.push(bytes.subarray(at, at + 7));
  }

  return reader.finish();
}

describe("UsageReader", () => {
  it("reads OpenRouter's usage and billed cost from a streamed chat completion", () => {
    const result = read(
      sse([
        {
          id: "gen-123",
          object: "chat.completion.chunk",
          model: "anthropic/claude-sonnet-4.6",
          provider: "Anthropic",
          choices: [{ delta: { content: "hi" } }],
        },
        {
          id: "gen-123",
          object: "chat.completion.chunk",
          model: "anthropic/claude-sonnet-4.6",
          provider: "Anthropic",
          choices: [],
          usage: {
            prompt_tokens: 2100,
            completion_tokens: 50,
            prompt_tokens_details: {
              cached_tokens: 900,
              cache_write_tokens: 100,
            },
            completion_tokens_details: { reasoning_tokens: 10 },
            cost: 0.0123,
            is_byok: false,
          },
        },
      ]).concat("data: [DONE]\n\n"),
    );

    expect(result).toMatchObject({
      api: "openai-chat",
      responseId: "gen-123",
      model: "anthropic/claude-sonnet-4.6",
      upstreamProvider: "Anthropic",
      usage: {
        input: 2100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 100,
        reasoning: 10,
      },
      costUsd: 0.0123,
      byok: false,
    });
    expect(result.raw).toMatchObject({ cost: 0.0123 });
  });

  it("counts Anthropic's cache tokens as input, and keeps its web searches", () => {
    const result = read(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 200,
              output_tokens: 1,
            },
          },
        },
        { type: "content_block_delta", delta: { text: "hello" } },
        {
          type: "message_delta",
          usage: {
            output_tokens: 75,
            server_tool_use: { web_search_requests: 2 },
          },
        },
        { type: "message_stop" },
      ]),
    );

    expect(result).toMatchObject({
      api: "anthropic-messages",
      responseId: "msg_1",
      usage: {
        input: 1110,
        output: 75,
        cacheRead: 900,
        cacheWrite: 200,
        webSearches: 2,
      },
    });
    expect(result.costUsd).toBeUndefined();
  });

  it("reads the usage on an OpenAI response's completed event", () => {
    const result = read(
      sse([
        { type: "response.output_text.delta", delta: "x" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            object: "response",
            model: "gpt-5.2",
            usage: {
              input_tokens: 500,
              output_tokens: 40,
              input_tokens_details: { cached_tokens: 300 },
              output_tokens_details: { reasoning_tokens: 20 },
            },
          },
        },
      ]),
    );

    expect(result).toMatchObject({
      api: "openai-responses",
      responseId: "resp_1",
      usage: { input: 500, output: 40, cacheRead: 300, reasoning: 20 },
    });
  });

  it("bills Gemini's tool-use prompt tokens and thoughts", () => {
    const result = read(
      sse([
        {
          responseId: "g-1",
          modelVersion: "gemini-3-flash",
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
        },
        {
          responseId: "g-1",
          modelVersion: "gemini-3-flash",
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 12,
            toolUsePromptTokenCount: 40,
            cachedContentTokenCount: 60,
          },
        },
      ]),
    );

    expect(result).toMatchObject({
      api: "google",
      responseId: "g-1",
      model: "gemini-3-flash",
      usage: {
        input: 140,
        output: 42,
        cacheRead: 60,
        reasoning: 12,
        toolUsePrompt: 40,
      },
    });
  });

  it("reads a plain JSON answer", () => {
    const result = read(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "gpt-oss-120b",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      false,
    );

    expect(result).toMatchObject({
      api: "openai-chat",
      responseId: "chatcmpl-1",
      usage: { input: 12, output: 3 },
    });
  });

  it("records nothing it cannot read, rather than a guess", () => {
    expect(read("not json at all", false)).toEqual({ api: "unknown" });
    expect(read("event: ping\n\ndata: {broken\n\n")).toEqual({
      api: "unknown",
    });
  });

  it("reads a final event with no trailing newline", () => {
    const text = sse([
      {
        id: "gen-9",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.5 },
      },
    ]).trimEnd();

    expect(read(text)).toMatchObject({ responseId: "gen-9", costUsd: 0.5 });
  });
});
