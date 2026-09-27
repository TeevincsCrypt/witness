// Input validation shared by the UI and the API route. Never throws.

import type { AgentStep, Column, MemoryInput, QueryInput, TableCard } from "./types";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

export function validateMemoryInput(raw: unknown): Validated<MemoryInput> {
  if (!isObj(raw)) return { ok: false, error: "Memory input must be an object with steps and compactionSummary." };
  const summary = str(raw.compactionSummary).trim();
  if (!summary) return { ok: false, error: "Paste the compaction summary to audit — it is the note the user never sees." };
  if (raw.steps !== undefined && !Array.isArray(raw.steps))
    return { ok: false, error: "Trace must be a JSON array of steps: [{ role, name?, content }]." };
  const steps: AgentStep[] = [];
  for (const [idx, s] of ((raw.steps as unknown[]) ?? []).entries()) {
    if (!isObj(s)) return { ok: false, error: `Step ${idx} is not an object.` };
    const role = s.role;
    if (role !== "user" && role !== "assistant" && role !== "tool")
      return { ok: false, error: `Step ${idx}: role must be "user", "assistant" or "tool".` };
    steps.push({
      i: typeof s.i === "number" ? s.i : idx,
      role,
      name: typeof s.name === "string" ? s.name : undefined,
      content: str(s.content),
    });
  }
  const reply = str(raw.nextUserVisibleReply).trim();
  return { ok: true, value: { steps, compactionSummary: summary, nextUserVisibleReply: reply || undefined } };
}

export function validateQueryInput(raw: unknown): Validated<QueryInput> {
  if (!isObj(raw)) return { ok: false, error: "Query input must be an object with tables and sql." };
  const sql = str(raw.sql).trim();
  if (!sql) return { ok: false, error: "Paste the SQL query to audit." };
  if (!Array.isArray(raw.tables) || raw.tables.length === 0)
    return { ok: false, error: "Schema must be a non-empty JSON array of table cards: [{ name, status, grain, description, columns }]." };
  const tables: TableCard[] = [];
  for (const [idx, t] of raw.tables.entries()) {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim())
      return { ok: false, error: `Table ${idx} needs a "name".` };
    const status = t.status === "canonical" || t.status === "deprecated" ? t.status : "unknown";
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
