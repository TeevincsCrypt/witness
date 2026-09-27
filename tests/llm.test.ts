import { afterEach, describe, expect, it, vi } from "vitest";
import { getLlmCall } from "../lib/llm";

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const err = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: "x" } }), { status, headers });

describe("LLM client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("surfaces the provider's error code and does not retry an empty account", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const fetchMock = vi.fn(async () => err(429, "insufficient_quota"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLlmCall()!("s", "u")).rejects.toThrow("LLM HTTP 429 insufficient_quota");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit once", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(err(429, "rate_limit_exceeded", { "retry-after": "0" }))
      .mockResolvedValueOnce(ok('{"findings": []}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLlmCall()!("s", "u")).resolves.toBe('{"findings": []}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 400 without optional params (provider quirks)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1/");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(err(400, "invalid_request_error"))
      .mockResolvedValueOnce(ok("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLlmCall()!("s", "u")).resolves.toBe("{}");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("reports a bad key clearly", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => err(401, "invalid_api_key")));
    await expect(getLlmCall()!("s", "u")).rejects.toThrow("LLM HTTP 401 invalid_api_key");
  });
});
