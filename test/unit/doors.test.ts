/**
 * Unit tests for the OpenAI Responses and Anthropic Messages doors: request parsing, the refusals
 * that keep this phase text-only and stateless, the JSON and SSE answer shapes, and error bodies.
 * Every refusal is checked for echoes: caller text never reaches an error message (OUT-1, LOG-1).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, ErrorKind, Usage } from "../../src/canonical.ts";
import { ERROR_STATUS, GatewayError } from "../../src/canonical.ts";
import { openAiError } from "../../src/doors/chat.ts";
import { messagesDoor } from "../../src/doors/messages.ts";
import { responsesDoor } from "../../src/doors/responses.ts";
import type { Door, DoorMeta, ParsedRequest } from "../../src/doors/types.ts";

/** Caller text planted in every bad request; it must never come back in an error. */
const CANARY = "CANARY-7f3a91";
/** A part, item or key name with characters `safeName` refuses to print. */
const WEIRD = `${CANARY} <b>"x"</b>`;

const meta: DoorMeta = { requestId: "req_abc123", created: 1_700_000_000, model: "claude-sonnet-4-5" };
const usage: Usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 };
const parsed: ParsedRequest = {
  alias: "sonnet",
  messages: [{ role: "user", text: "hi" }],
  stream: true,
  ignoredParams: [],
};

const START: CanonicalEvent = { type: "start", providerModel: "claude-sonnet-4-5" };
const FULL: CanonicalEvent[] = [
  START,
  { type: "text", delta: "Hel" },
  { type: "text", delta: "lo" },
  { type: "usage", usage },
  { type: "done", finish: "stop" },
];

function refusal(door: Door, body: unknown, strict = false): GatewayError {
  try {
    door.parse(body, strict);
  } catch (e) {
    if (e instanceof GatewayError) return e;
    throw e;
  }
  throw new Error("expected the door to refuse the request");
}

/** No caller text in the message, the param or the HTTP error body built from them. */
function expectNoEcho(door: Door, e: GatewayError): void {
  expect(e.kind).toBe("bad_request");
  expect(e.status).toBe(400);
  expect(e.message).not.toContain(CANARY);
  expect(e.param ?? "").not.toContain(CANARY);
  expect(JSON.stringify(door.errorBody(e))).not.toContain(CANARY);
}

type Frame = { event: string; data: any };
const dec = new TextDecoder();

/** Decodes named SSE events and checks each event name matches its `type`. */
function decode(frames: Uint8Array[]): Frame[] {
  return frames.map((f) => {
    const s = dec.decode(f);
    const m = /^event: ([a-z_.]+)\ndata: (.*)\n\n$/s.exec(s);
    if (!m) throw new Error("not a named SSE event");
    const data = JSON.parse(m[2]!);
    expect(data.type).toBe(m[1]!);
    return { event: m[1]!, data };
  });
}

/** Runs events through a fresh writer; returns the frames grouped per event. */
function run(door: Door, events: CanonicalEvent[]): Frame[][] {
  const w = door.stream(meta, parsed);
  return events.map((ev) => decode(w.frames(ev)));
}

describe("responses door: parsing", () => {
  test("a string input is one user message", () => {
    expect(responsesDoor.name).toBe("responses");
    expect(responsesDoor.parse({ model: "sonnet", input: "Hello" }, false)).toEqual({
      alias: "sonnet",
      messages: [{ role: "user", text: "Hello" }],
      stream: false,
      ignoredParams: [],
    });
  });

  test("an item array: instructions first in the system text, then system and developer items", () => {
    const p = responsesDoor.parse(
      {
        model: "sonnet",
        instructions: "Be brief.",
        stream: true,
        input: [
          { role: "system", content: "Sys one." },
          {
            type: "message",
            role: "developer",
            content: [
              { type: "input_text", text: "Dev a" },
              { type: "input_text", text: "Dev b" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: "Q1 line 1" },
              { type: "input_text", text: "Q1 line 2" },
            ],
          },
          {
            type: "message",
            role: "assistant",
            id: "msg_prev",
            status: "completed",
            content: [{ type: "output_text", text: "A1", annotations: [] }],
          },
          { role: "user", content: "Q2" },
        ],
      },
      false,
    );
    expect(p.system).toBe("Be brief.\n\nSys one.\n\nDev a\nDev b");
    expect(p.messages).toEqual([
      { role: "user", text: "Q1 line 1\nQ1 line 2" },
      { role: "assistant", text: "A1" },
      { role: "user", text: "Q2" },
    ]);
    expect(p.stream).toBe(true);
    expect(p.ignoredParams).toEqual([]);
  });

  test("no instructions and no system items: no system text", () => {
    expect(responsesDoor.parse({ model: "sonnet", input: "hi", instructions: null }, false).system).toBeUndefined();
    expect(responsesDoor.parse({ model: "sonnet", input: "hi" }, false).system).toBeUndefined();
  });

  test("parameters that can't be honoured are dropped and listed, with unsafe names masked", () => {
    const p = responsesDoor.parse(
      {
        model: "sonnet",
        input: "hi",
        temperature: 0.2,
        top_p: 1,
        max_output_tokens: 100,
        metadata: { a: "b" },
        user: "u",
        store: false,
        include: [],
        reasoning: { effort: "low" },
        truncation: "auto",
        parallel_tool_calls: true,
        service_tier: "auto",
        tool_choice: "auto",
        tools: [],
        surprise: 1,
        [WEIRD]: 2,
        previous_response_id: null,
        conversation: null,
        background: false,
        text: { format: { type: "text" } },
      },
      false,
    );
    expect(p.ignoredParams).toEqual([
      "(invalid-name)",
      "include",
      "max_output_tokens",
      "metadata",
      "parallel_tool_calls",
      "reasoning",
      "service_tier",
      "store",
      "surprise",
      "temperature",
      "tool_choice",
      "top_p",
      "truncation",
      "user",
    ]);
    expect(JSON.stringify(p.ignoredParams)).not.toContain(CANARY);
  });

  test("text is handled when it only asks for plain text; anything more in it is listed", () => {
    expect(
      responsesDoor.parse({ model: "s", input: "hi", text: { format: { type: "text" } } }, false).ignoredParams,
    ).toEqual([]);
    expect(
      responsesDoor.parse({ model: "s", input: "hi", text: { format: { type: "text" }, verbosity: "low" } }, false)
        .ignoredParams,
    ).toEqual(["text"]);
  });

  test("strict_params turns an ignored parameter into a 400 naming it", () => {
    const e = refusal(responsesDoor, { model: "sonnet", input: "hi", top_p: 1, temperature: 0 }, true);
    expect(e.status).toBe(400);
    expect(e.message).toBe("strict_params is on and these parameters can't be honoured: temperature, top_p");
    expect(e.param).toBe("temperature");
    expect(responsesDoor.parse({ model: "sonnet", input: "hi", tools: [] }, true).ignoredParams).toEqual([]);
  });

  test.each([
    [[], "At least one user message is required."],
    [[{ role: "system", content: "only system" }], "At least one user message is required."],
    [
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      "The last message must be from the user.",
    ],
  ])("conversation checks: %j", (input, message) => {
    const e = refusal(responsesDoor, { model: "sonnet", input });
    expect(e.message).toBe(message);
    expect(e.param).toBe("input");
  });

  const user = { role: "user", content: `hello ${CANARY}` };
  test.each([
    [
      { previous_response_id: `resp_${CANARY}` },
      "sapi is stateless: send the whole conversation in input.",
      "previous_response_id",
    ],
    [
      { conversation: { id: `conv_${CANARY}` } },
      "sapi is stateless: send the whole conversation in input.",
      "conversation",
    ],
    [{ tools: [{ type: "function", name: CANARY }] }, "Tool calling isn't supported by sapi yet (planned).", "tools"],
    [
      { text: { format: { type: "json_schema", name: CANARY, schema: {} } } },
      "Structured output (text.format) isn't supported by sapi yet (planned).",
      "text",
    ],
    [{ background: true }, "Background responses aren't supported: sapi is stateless.", "background"],
    [
      { prompt: { id: `pmpt_${CANARY}` } },
      "Stored prompt templates (prompt) aren't supported: sapi is stateless.",
      "prompt",
    ],
  ])("refused: %j", (extra, message, param) => {
    const e = refusal(responsesDoor, { model: "sonnet", input: [user], ...extra });
    expect(e.message).toBe(message);
    expect(e.param).toBe(param);
    expectNoEcho(responsesDoor, e);
  });

  test.each(["input_image", "input_file", "input_audio"])("a %s part is refused", (type) => {
    const e = refusal(responsesDoor, {
      model: "sonnet",
      input: [
        user,
        {
          role: "user",
          content: [
            { type: "input_text", text: CANARY },
            { type, image_url: CANARY },
          ],
        },
      ],
    });
    expect(e.message).toBe(`Only text content is supported by this provider (input[1] has a "${type}" part).`);
    expectNoEcho(responsesDoor, e);
  });

  test.each(["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"])(
    "a %s item is refused",
    (type) => {
      const e = refusal(responsesDoor, {
        model: "sonnet",
        input: [user, { type, call_id: CANARY, name: CANARY, output: CANARY }, user],
      });
      expect(e.message).toBe("Tool messages aren't supported by sapi yet (planned).");
      expect(e.param).toBe("input[1]");
      expectNoEcho(responsesDoor, e);
    },
  );

  test.each(["reasoning", "item_reference", "web_search_call"])("a %s item is refused, naming the type", (type) => {
    const e = refusal(responsesDoor, { model: "sonnet", input: [{ type, id: CANARY, summary: [] }, user] });
    expect(e.message).toBe(`Only message items are supported in input (input[0] is a "${type}" item).`);
    expectNoEcho(responsesDoor, e);
  });

  test("a weird part or item type is masked, never echoed", () => {
    const part = refusal(responsesDoor, { model: "sonnet", input: [{ role: "user", content: [{ type: WEIRD }] }] });
    expect(part.message).toBe(
      'Only text content is supported by this provider (input[0] has a "(invalid-name)" part).',
    );
    expectNoEcho(responsesDoor, part);
    const item = refusal(responsesDoor, { model: "sonnet", input: [{ type: WEIRD }, user] });
    expect(item.message).toBe('Only message items are supported in input (input[0] is a "(invalid-name)" item).');
    expectNoEcho(responsesDoor, item);
  });

  test.each([
    [{ input: "hi" }, "model"],
    [{ model: "", input: "hi" }, "model"],
    [{ model: CANARY.repeat(20), input: "hi" }, "model"],
    [{ model: "sonnet" }, "input"],
    [{ model: "sonnet", input: 42 }, "input"],
    [{ model: "sonnet", input: Array.from({ length: 2001 }, () => user) }, "input"],
    [{ model: "sonnet", input: [{ content: CANARY }] }, "input.0.role"],
    [{ model: "sonnet", input: [{ role: "tool", content: CANARY }] }, "input.0.role"],
    [{ model: "sonnet", input: [{ type: "message", role: "user" }] }, "input.0.content"],
    [{ model: "sonnet", input: [user, { role: "user", content: [{ type: 7 }] }] }, "input.1.content"],
    [{ model: "sonnet", input: "hi", instructions: 5 }, "instructions"],
    [{ model: "sonnet", input: "hi", stream: "yes" }, "stream"],
  ])("schema problems name the path only: %#", (body, param) => {
    const e = refusal(responsesDoor, body);
    expect(e.param).toBe(param);
    expect(e.message.startsWith(`Invalid request: ${param}: `)).toBe(true);
    expectNoEcho(responsesDoor, e);
  });

  test("a text part without text gets a fixed message", () => {
    const e = refusal(responsesDoor, { model: "sonnet", input: [{ role: "user", content: [{ type: "input_text" }] }] });
    expect(e.message).toBe("Invalid request: input[0]: a text part needs a text string.");
  });
});

describe("responses door: complete()", () => {
  test("the response object, with usage mapped (input includes cache reads and writes)", () => {
    expect(responsesDoor.complete(meta, "Hello", "stop", usage)).toEqual({
      id: "resp_abc123",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      model: "claude-sonnet-4-5",
      output: [
        {
          type: "message",
          id: "msg_abc123",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
      ],
      parallel_tool_calls: false,
      tool_choice: "auto",
      tools: [],
      store: false,
      temperature: null,
      top_p: null,
      text: { format: { type: "text" } },
      metadata: {},
      usage: {
        input_tokens: 15,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 20,
      },
    });
  });

  test("no usage reported: zeros", () => {
    const body = responsesDoor.complete(meta, "", "stop", undefined) as any;
    expect(body.usage).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });

  test("finish length: incomplete, reason max_output_tokens", () => {
    const body = responsesDoor.complete(meta, "Hel", "length", usage) as any;
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  test("a request ID without the req_ prefix is used whole", () => {
    const body = responsesDoor.complete({ ...meta, requestId: "xyz" }, "", "stop", undefined) as any;
    expect(body.id).toBe("resp_xyz");
    expect(body.output[0].id).toBe("msg_xyz");
  });
});

describe("responses door: streaming", () => {
  const inProgress = {
    ...(responsesDoor.complete(meta, "", "stop", undefined) as object),
    status: "in_progress",
    output: [],
    usage: null,
  };
  const ids = { item_id: "msg_abc123", output_index: 0, content_index: 0 };

  test("start, two texts, usage, done: the exact event sequence", () => {
    const groups = run(responsesDoor, FULL);
    expect(groups.map((g) => g.map((f) => f.event))).toEqual([
      ["response.created", "response.in_progress"],
      ["response.output_item.added", "response.content_part.added", "response.output_text.delta"],
      ["response.output_text.delta"],
      [],
      ["response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"],
    ]);
    const frames = groups.flat();
    expect(frames.map((f) => f.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const data = frames.map(({ data: { sequence_number: _, ...rest } }) => rest);
    const part = { type: "output_text", text: "Hello", annotations: [] };
    expect(data).toEqual([
      { type: "response.created", response: inProgress },
      { type: "response.in_progress", response: inProgress },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_abc123", status: "in_progress", role: "assistant", content: [] },
      },
      { type: "response.content_part.added", ...ids, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", ...ids, delta: "Hel", logprobs: [] },
      { type: "response.output_text.delta", ...ids, delta: "lo", logprobs: [] },
      { type: "response.output_text.done", ...ids, text: "Hello", logprobs: [] },
      { type: "response.content_part.done", ...ids, part },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_abc123", status: "completed", role: "assistant", content: [part] },
      },
      { type: "response.completed", response: responsesDoor.complete(meta, "Hello", "stop", usage) },
    ]);
  });

  test("start then done with no text: the item still opens and closes, empty", () => {
    const frames = run(responsesDoor, [START, { type: "done", finish: "stop" }]).flat();
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames.map((f) => f.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(frames[4]!.data.text).toBe("");
    expect(frames[7]!.data.response).toEqual(responsesDoor.complete(meta, "", "stop", undefined));
  });

  test("finish length ends with response.incomplete", () => {
    const frames = run(responsesDoor, [
      START,
      { type: "text", delta: "Hel" },
      { type: "done", finish: "length" },
    ]).flat();
    const last = frames[frames.length - 1]!;
    expect(last.event).toBe("response.incomplete");
    expect(last.data.response).toEqual(responsesDoor.complete(meta, "Hel", "length", undefined));
  });

  test("limit events send nothing; a text before start still opens the lifecycle; nothing after done", () => {
    const w = responsesDoor.stream(meta, parsed);
    expect(w.frames({ type: "limit", limit: { window: "5h", usedPct: 10, source: "reported" } })).toEqual([]);
    expect(decode(w.frames({ type: "text", delta: "x" })).map((f) => f.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
    ]);
    expect(w.frames(START)).toEqual([]);
    expect(decode(w.frames({ type: "done", finish: "stop" }))).toHaveLength(4);
    expect(w.frames({ type: "text", delta: "late" })).toEqual([]);
  });

  test("error(): one error event that continues the sequence", () => {
    const w = responsesDoor.stream(meta, parsed);
    w.frames(START);
    w.frames({ type: "text", delta: "Hi" });
    const [frame, ...rest] = decode(w.error(new GatewayError("upstream_error", "The provider failed.")));
    expect(rest).toEqual([]);
    expect(frame!.event).toBe("error");
    expect(frame!.data).toEqual({
      type: "error",
      code: "upstream_error",
      message: "The provider failed.",
      param: null,
      sapi_error_kind: "upstream_error",
      sequence_number: 5,
    });
    const timeout = decode(
      responsesDoor.stream(meta, parsed).error(new GatewayError("timeout", "Timed out.", { param: "x" })),
    );
    expect(timeout[0]!.data).toMatchObject({ code: "timeout", param: "x", sequence_number: 0 });
  });
});

describe("messages door: parsing", () => {
  test("string content; max_tokens (always sent by the SDK) is listed as ignored", () => {
    expect(messagesDoor.name).toBe("messages");
    expect(
      messagesDoor.parse({ model: "sonnet", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] }, false),
    ).toEqual({
      alias: "sonnet",
      messages: [{ role: "user", text: "Hello" }],
      stream: false,
      ignoredParams: ["max_tokens"],
    });
  });

  test("text blocks join with newlines, system blocks with blank lines; cache_control is ignored", () => {
    const p = messagesDoor.parse(
      {
        model: "sonnet",
        stream: true,
        system: [
          { type: "text", text: "Sys a" },
          { type: "text", text: "Sys b", cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Q1 line 1" },
              { type: "text", text: "Q1 line 2", cache_control: { type: "ephemeral" } },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "A1", citations: null }] },
          { role: "user", content: "Q2" },
        ],
      },
      false,
    );
    expect(p.system).toBe("Sys a\n\nSys b");
    expect(p.messages).toEqual([
      { role: "user", text: "Q1 line 1\nQ1 line 2" },
      { role: "assistant", text: "A1" },
      { role: "user", text: "Q2" },
    ]);
    expect(p.stream).toBe(true);
    expect(p.ignoredParams).toEqual([]);
  });

  test("a string system prompt; no system means no system text", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(messagesDoor.parse({ model: "s", system: "Be brief.", messages }, false).system).toBe("Be brief.");
    expect(messagesDoor.parse({ model: "s", messages }, false).system).toBeUndefined();
  });

  test("sampling and other unhonoured parameters are dropped and listed, with unsafe names masked", () => {
    const p = messagesDoor.parse(
      {
        model: "sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1024,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["END"],
        metadata: { user_id: "u" },
        service_tier: "auto",
        thinking: { type: "enabled", budget_tokens: 1024 },
        tool_choice: { type: "auto" },
        tools: [],
        mcp_servers: [],
        container: null,
        surprise: true,
        [WEIRD]: 1,
      },
      false,
    );
    expect(p.ignoredParams).toEqual([
      "(invalid-name)",
      "max_tokens",
      "metadata",
      "service_tier",
      "stop_sequences",
      "surprise",
      "temperature",
      "thinking",
      "tool_choice",
      "top_k",
      "top_p",
    ]);
    expect(JSON.stringify(p.ignoredParams)).not.toContain(CANARY);
  });

  test("strict_params: a 400 naming the ignored parameters", () => {
    const e = refusal(
      messagesDoor,
      { model: "sonnet", max_tokens: 1024, temperature: 1, messages: [{ role: "user", content: "hi" }] },
      true,
    );
    expect(e.message).toBe("strict_params is on and these parameters can't be honoured: temperature");
    expect(e.param).toBe("temperature");
    expect(
      messagesDoor.parse({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }, true).ignoredParams,
    ).toEqual([]);
    // max_tokens is required by the Messages API, so strict mode lists it but never refuses it.
    expect(
      messagesDoor.parse({ model: "sonnet", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, true)
        .ignoredParams,
    ).toEqual(["max_tokens"]);
  });

  test.each([
    [[{ role: "assistant", content: "hello" }], "At least one user message is required."],
    [
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      "The last message must be from the user.",
    ],
  ])("conversation checks: %j", (messages, message) => {
    const e = refusal(messagesDoor, { model: "sonnet", messages });
    expect(e.message).toBe(message);
    expect(e.param).toBe("messages");
  });

  const user = { role: "user", content: `hello ${CANARY}` };
  test.each([
    [{ tools: [{ name: CANARY, input_schema: {} }] }, "Tool calling isn't supported by sapi yet (planned).", "tools"],
    [
      { mcp_servers: [{ type: "url", url: `https://${CANARY}.example`, name: CANARY }] },
      "MCP servers (mcp_servers) aren't supported by sapi.",
      "mcp_servers",
    ],
    [
      { container: `container_${CANARY}` },
      "Code execution containers (container) aren't supported by sapi.",
      "container",
    ],
  ])("refused: %j", (extra, message, param) => {
    const e = refusal(messagesDoor, { model: "sonnet", max_tokens: 10, messages: [user], ...extra });
    expect(e.message).toBe(message);
    expect(e.param).toBe(param);
    expectNoEcho(messagesDoor, e);
  });

  test.each(["image", "document", "thinking", "redacted_thinking", "search_result"])(
    "a %s block is refused, naming the type",
    (type) => {
      const e = refusal(messagesDoor, {
        model: "sonnet",
        messages: [
          user,
          {
            role: "user",
            content: [
              { type: "text", text: CANARY },
              { type, data: CANARY },
            ],
          },
        ],
      });
      expect(e.message).toBe(`Only text content is supported by this provider (messages[1] has a "${type}" part).`);
      expect(e.param).toBe("messages");
      expectNoEcho(messagesDoor, e);
    },
  );

  test.each(["tool_use", "tool_result", "server_tool_use", "web_search_tool_result"])(
    "a %s block is refused",
    (type) => {
      const e = refusal(messagesDoor, {
        model: "sonnet",
        messages: [user, { role: "assistant", content: [{ type, id: CANARY, content: CANARY }] }, user],
      });
      expect(e.message).toBe("Tool messages aren't supported by sapi yet (planned).");
      expect(e.param).toBe("messages[1]");
      expectNoEcho(messagesDoor, e);
    },
  );

  test("a weird block type is masked, never echoed", () => {
    const e = refusal(messagesDoor, { model: "sonnet", messages: [{ role: "user", content: [{ type: WEIRD }] }] });
    expect(e.message).toBe(
      'Only text content is supported by this provider (messages[0] has a "(invalid-name)" part).',
    );
    expectNoEcho(messagesDoor, e);
  });

  test.each([
    [{ messages: [user] }, "model"],
    [{ model: CANARY.repeat(20), messages: [user] }, "model"],
    [{ model: "sonnet" }, "messages"],
    [{ model: "sonnet", messages: [] }, "messages"],
    [{ model: "sonnet", messages: Array.from({ length: 2001 }, () => user) }, "messages"],
    [{ model: "sonnet", messages: [{ role: "system", content: CANARY }] }, "messages.0.role"],
    [{ model: "sonnet", messages: [{ role: "user" }] }, "messages.0.content"],
    [{ model: "sonnet", messages: [{ role: "user", content: [{ text: CANARY }] }] }, "messages.0.content"],
    [{ model: "sonnet", messages: [user], system: [{ type: "image", source: CANARY }] }, "system"],
    [{ model: "sonnet", messages: [user], system: [{ type: "text" }] }, "system"],
    [{ model: "sonnet", messages: [user], max_tokens: "many" }, "max_tokens"],
    [{ model: "sonnet", messages: [user], stream: 1 }, "stream"],
  ])("schema problems name the path only: %#", (body, param) => {
    const e = refusal(messagesDoor, body);
    expect(e.param).toBe(param);
    expect(e.message.startsWith(`Invalid request: ${param}: `)).toBe(true);
    expectNoEcho(messagesDoor, e);
  });

  test("a text block without text gets a fixed message", () => {
    const e = refusal(messagesDoor, { model: "sonnet", messages: [{ role: "user", content: [{ type: "text" }] }] });
    expect(e.message).toBe("Invalid request: messages[0]: a text block needs a text string.");
  });
});

describe("messages door: complete()", () => {
  test("the message object, with usage mapped (input excludes cache reads and writes)", () => {
    expect(messagesDoor.complete(meta, "Hello", "stop", usage)).toEqual({
      id: "msg_abc123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    });
  });

  test.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
  ] as const)("finish %s → stop_reason %s", (finish, stopReason) => {
    expect((messagesDoor.complete(meta, "x", finish, usage) as any).stop_reason).toBe(stopReason);
  });

  test("no usage reported: zeros", () => {
    expect((messagesDoor.complete(meta, "", "stop", undefined) as any).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("messages door: streaming", () => {
  const messageStart = {
    type: "message_start",
    message: {
      id: "msg_abc123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  const blockStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };

  test("start, two texts, usage, done: the exact event sequence", () => {
    const groups = run(messagesDoor, FULL);
    expect(groups.map((g) => g.map((f) => f.event))).toEqual([
      ["message_start"],
      ["content_block_start", "content_block_delta"],
      ["content_block_delta"],
      [],
      ["content_block_stop", "message_delta", "message_stop"],
    ]);
    expect(groups.flat().map((f) => f.data)).toEqual([
      messageStart,
      blockStart,
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
      },
      { type: "message_stop" },
    ]);
  });

  test("start then done with no text: an empty block still opens and closes", () => {
    const frames = run(messagesDoor, [START, { type: "done", finish: "stop" }]).flat();
    expect(frames.map((f) => f.data)).toEqual([
      messageStart,
      blockStart,
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
  });

  test("finish length: stop_reason max_tokens", () => {
    const frames = run(messagesDoor, [START, { type: "done", finish: "length" }]).flat();
    expect(frames.find((f) => f.event === "message_delta")!.data.delta.stop_reason).toBe("max_tokens");
  });

  test("limit events send nothing; a text before start still sends message_start first; nothing after done", () => {
    const w = messagesDoor.stream(meta, parsed);
    expect(w.frames({ type: "limit", limit: { window: "5h", usedPct: 10, source: "reported" } })).toEqual([]);
    expect(decode(w.frames({ type: "text", delta: "x" })).map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ]);
    expect(w.frames(START)).toEqual([]);
    expect(decode(w.frames({ type: "done", finish: "stop" }))).toHaveLength(3);
    expect(w.frames({ type: "text", delta: "late" })).toEqual([]);
  });

  test("error(): one Anthropic error event", () => {
    const w = messagesDoor.stream(meta, parsed);
    w.frames(START);
    const frames = decode(w.error(new GatewayError("upstream_error", "The provider failed.")));
    expect(frames).toEqual([
      {
        event: "error",
        data: {
          type: "error",
          error: { type: "api_error", message: "The provider failed.", sapi_error_kind: "upstream_error" },
        },
      },
    ]);
  });
});

describe("error bodies", () => {
  const kinds = Object.keys(ERROR_STATUS) as ErrorKind[];

  test("responses: the OpenAI error body, for every kind", () => {
    for (const kind of kinds) {
      const e = new GatewayError(kind, "Fixed message.", { param: "model" });
      expect(responsesDoor.errorBody(e)).toEqual(openAiError(e));
    }
    expect(responsesDoor.errorBody(new GatewayError("bad_request", "Bad.", { param: "input" }))).toEqual({
      error: {
        message: "Bad.",
        type: "invalid_request_error",
        param: "input",
        code: "bad_request",
        sapi_error_kind: "bad_request",
      },
    });
  });

  test("messages: Anthropic error types, for every kind", () => {
    const expected: Record<ErrorKind, string> = {
      unauthorized: "authentication_error",
      forbidden: "permission_error",
      bad_request: "invalid_request_error",
      not_found: "not_found_error",
      method_not_allowed: "invalid_request_error",
      payload_too_large: "request_too_large",
      unsupported_media_type: "invalid_request_error",
      rate_limited: "rate_limit_error",
      client_budget_exceeded: "rate_limit_error",
      provider_window_exhausted: "rate_limit_error",
      provider_paused: "api_error",
      provider_not_ready: "api_error",
      upstream_error: "api_error",
      timeout: "timeout_error",
      client_closed: "api_error",
      internal_error: "api_error",
    };
    for (const kind of kinds) {
      expect(messagesDoor.errorBody(new GatewayError(kind, "Fixed message."))).toEqual({
        type: "error",
        error: { type: expected[kind], message: "Fixed message.", sapi_error_kind: kind },
      });
    }
  });
});
