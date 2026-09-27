// Server-only: OpenAI-compatible chat call behind OPENAI_API_KEY / OPENAI_BASE_URL.
// Never blocks the demo — callers catch every failure and keep rule findings.

import type { LlmCall } from "./types";

export function llmModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

export function llmConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function getLlmCall(): LlmCall | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const timeoutMs = Number(process.env.WITNESS_LLM_TIMEOUT_MS) || 15000;
  const model = llmModel();

  return async (system, user) => {
    const post = (jsonMode: boolean) =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res = await post(true);
    // Some OpenAI-compatible servers reject response_format; retry once without it.
    if (res.status === 400) res = await post(false);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("empty LLM response");
    return content;
  };
}
