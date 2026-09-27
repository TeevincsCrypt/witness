import { auditMemory } from "@/lib/memoryAuditor";
import { auditQuery } from "@/lib/queryAuditor";
import { getLlmCall, llmConfigured, llmModel } from "@/lib/llm";
import { validateMemoryInput, validateQueryInput } from "@/lib/validate";

export const maxDuration = 30;

export async function GET() {
  return Response.json({ llm: llmConfigured(), model: llmConfigured() ? llmModel() : null });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const { module: mod, input, llm } = (body ?? {}) as { module?: string; input?: unknown; llm?: boolean };
  const opts = { llm: llm === false ? null : getLlmCall(), llmModel: llmModel() };

  if (mod === "memory") {
    const v = validateMemoryInput(input);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
    return Response.json(await auditMemory(v.value, opts));
  }
  if (mod === "query") {
    const v = validateQueryInput(input);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
    return Response.json(await auditQuery(v.value, opts));
  }
  return Response.json({ error: 'module must be "memory" or "query".' }, { status: 400 });
}
