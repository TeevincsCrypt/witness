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
    // One budget for the whole call, retries included, so the route stays under maxDuration.
    const deadline = Date.now() + timeoutMs;
    // Providers differ on optional params (Groq, Together, local servers…); on a 400 retry with a bare request.
    let plain = false;
    const post = () =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(plain ? {} : { temperature: 0, response_format: { type: "json_object" } }),
        }),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });

    let res = await post();
    let code = res.ok ? "" : await errorCode(res);
    if (res.status === 400) {
      plain = true;
      res = await post();
      code = res.ok ? "" : await errorCode(res);
    }
    // A true rate limit is worth one short retry; an empty account (insufficient_quota) is not.
    if (res.status === 429 && code !== "insufficient_quota" && deadline - Date.now() > 3000) {
      const wait = Math.min(2000, (Number(res.headers.get("retry-after")) || 1) * 1000);
      await new Promise((r) => setTimeout(r, wait));
      res = await post();
      code = res.ok ? "" : await errorCode(res);
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}${code ? ` ${code}` : ""}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("empty LLM response");
    return content;
  };
}

/** OpenAI-style error code ("insufficient_quota", "invalid_api_key", …) from an error response. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
    const c = body.error?.code ?? body.error?.type;
    return typeof c === "string" ? c.replace(/[^\w.-]/g, "").slice(0, 40) : "";
  } catch {
    return "";
  }
}
