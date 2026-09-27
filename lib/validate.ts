// Input validation shared by the UI and the API route. Never throws.

import type { AgentStep, Column, MemoryInput, QueryInput, TableCard } from "./types";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

const ROLE_ALIAS: Record<string, AgentStep["role"]> = {
  user: "user",
  human: "user",
  system: "user", // principal instructions; shown as user with name "system"
  developer: "user",
  assistant: "assistant",
  ai: "assistant",
  model: "assistant",
  tool: "tool",
  function: "tool",
  ipython: "tool",
};

/** Flatten OpenAI / Anthropic / LangChain message content into text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) return str(content);
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!isObj(b)) return str(b);
      if (b.type === "text" || typeof b.text === "string") return str(b.text);
      if (b.type === "tool_result") return contentText(b.content);
      if (b.type === "tool_use") return `${str(b.name)}(${str(b.input)})`;
      return str(b);
    })
    .join("\n");
}

export function validateMemoryInput(raw: unknown): Validated<MemoryInput> {
  if (!isObj(raw)) return { ok: false, error: "Memory input must be an object with steps and compactionSummary." };
  const summary = str(raw.compactionSummary).trim();
  if (!summary) return { ok: false, error: "Paste the compaction summary to audit — it is the note the user never sees." };
  const rawSteps = raw.steps ?? raw.messages;
  if (rawSteps !== undefined && !Array.isArray(rawSteps))
    return { ok: false, error: "Trace must be a JSON array of steps: [{ role, name?, content }]." };
  const steps: AgentStep[] = [];
  const toolNames = new Map<string, string>(); // tool_call id → tool name
  for (const [idx, s] of ((rawSteps as unknown[]) ?? []).entries()) {
    if (!isObj(s)) return { ok: false, error: `Step ${idx} is not an object.` };
    const roleRaw = String(s.role ?? s.type ?? "").toLowerCase();
    let role = ROLE_ALIAS[roleRaw];
    if (!role) return { ok: false, error: `Step ${idx}: unknown role "${roleRaw}" (use user, assistant or tool).` };
    let name = typeof s.name === "string" ? s.name : typeof s.tool_name === "string" ? s.tool_name : undefined;
    if (roleRaw === "system" || roleRaw === "developer") name = roleRaw;

    // Remember tool call ids so tool results can show which tool produced them.
    for (const tc of Array.isArray(s.tool_calls) ? s.tool_calls : []) {
      if (isObj(tc) && isObj(tc.function) && typeof tc.id === "string") toolNames.set(tc.id, str(tc.function.name));
    }
    const blocks = Array.isArray(s.content) ? s.content.filter(isObj) : [];
    for (const b of blocks) if (b.type === "tool_use" && typeof b.id === "string") toolNames.set(b.id, str(b.name));
    const result = blocks.find((b) => b.type === "tool_result");
    if (result) {
      role = "tool"; // Anthropic returns tool results inside a user message
      name ??= toolNames.get(str(result.tool_use_id));
    }
    if (role === "tool" && !name && typeof s.tool_call_id === "string") name = toolNames.get(s.tool_call_id);

    let content = contentText(s.content);
    if (!content && Array.isArray(s.tool_calls)) {
      content = s.tool_calls
        .map((tc) => (isObj(tc) && isObj(tc.function) ? `${str(tc.function.name)}(${str(tc.function.arguments)})` : str(tc)))
        .join("\n");
    }
    steps.push({ i: typeof s.i === "number" ? s.i : idx, role, name, content });
  }
  const reply = str(raw.nextUserVisibleReply).trim();
  return { ok: true, value: { steps, compactionSummary: summary, nextUserVisibleReply: reply || undefined } };
}

const STATUS_ALIAS: Record<string, TableCard["status"]> = {
  canonical: "canonical",
  certified: "canonical",
  gold: "canonical",
  production: "canonical",
  prod: "canonical",
  active: "canonical",
  current: "canonical",
  deprecated: "deprecated",
  legacy: "deprecated",
  stale: "deprecated",
  archived: "deprecated",
  obsolete: "deprecated",
};

export function validateQueryInput(raw: unknown): Validated<QueryInput> {
  if (!isObj(raw)) return { ok: false, error: "Query input must be an object with tables and sql." };
  const sql = str(raw.sql).trim();
  if (!sql) return { ok: false, error: "Paste the SQL query to audit." };
  // Accept an array of cards or a { tableName: card } map.
  const list: unknown[] = Array.isArray(raw.tables)
    ? raw.tables
    : isObj(raw.tables)
      ? Object.entries(raw.tables).map(([name, t]) => (isObj(t) ? { name, ...t } : { name }))
      : [];
  if (list.length === 0)
    return { ok: false, error: "Schema must be a non-empty JSON array of table cards: [{ name, status, grain, description, columns }]." };
  const tables: TableCard[] = [];
  for (const [idx, t] of list.entries()) {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim())
      return { ok: false, error: `Table ${idx} needs a "name".` };
    const status = STATUS_ALIAS[String(t.status ?? "").trim().toLowerCase()] ?? "unknown";
    const columns: Column[] = (Array.isArray(t.columns) ? t.columns : [])
      .map((c) => (typeof c === "string" ? { name: c, type: "" } : isObj(c) ? { name: str(c.name), type: str(c.type) } : null))
      .filter((c): c is Column => !!c && !!c.name);
    tables.push({
      name: t.name.trim(),
      description: str(t.description),
      grain: str(t.grain),
      status,
      columns,
      sampleRows: Array.isArray(t.sampleRows) ? (t.sampleRows.filter(isObj) as Record<string, unknown>[]) : undefined,
    });
  }
  const question = str(raw.question).trim();
  return { ok: true, value: { tables, sql, question: question || undefined } };
}
