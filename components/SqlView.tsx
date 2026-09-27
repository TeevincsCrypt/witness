"use client";

import type { Finding, QueryInput, TableCard } from "@/lib/types";
import { marksFor, type Mark } from "@/lib/highlight";
import { analyzeSql, isFact, isUniqueOn, usedColumns } from "@/lib/queryAuditor";
import type { SqlAnalysis } from "@/lib/sqlParse";
import { Highlighted, type PickHandler } from "./Highlighted";

const STATUS_CLS: Record<TableCard["status"], string> = {
  canonical: "border-ok/50 text-ok",
  deprecated: "border-bad/60 text-bad",
  unknown: "border-line-2 text-dim",
};

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-dim">{children}</div>;
}

/** Join-key columns of `card` whose sample values repeat — the visible cause of a fan-out. */
function duplicateKeys(analysis: SqlAnalysis, card: TableCard): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const keys = new Set<string>();
  for (const j of analysis.joins)
    for (const p of j.pairs)
      for (const side of [p.left, p.right]) if (side.card === card) keys.add(side.column);
  if (isFact(card)) return out; // many rows per key is expected on the fact side
  for (const key of keys) {
    if (isUniqueOn(card, key) !== false || !card.sampleRows) continue;
    const counts = new Map<string, number>();
    for (const r of card.sampleRows) {
      const v = r[key];
      if (v !== undefined && v !== null) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    const dups = new Set([...counts].filter(([, n]) => n > 1).map(([v]) => v));
    if (dups.size) out.set(key, dups);
  }
  return out;
}

function SchemaCard({
  card,
  analysis,
  used,
  suggested,
  marks,
  activeId,
  onPick,
}: {
  card: TableCard;
  analysis: SqlAnalysis;
  used: boolean;
  suggested: boolean;
  marks: Mark[];
  activeId?: string | null;
  onPick?: PickHandler;
}) {
  const cols = usedColumns(analysis, card);
  const dups = duplicateKeys(analysis, card);
  const alias = analysis.tables.find((t) => t.card === card)?.alias;
  const flagged = marks.some((m) => card.description && card.description.toLowerCase().includes(m.quote.toLowerCase()));
  const border = used && card.status === "deprecated" ? "border-bad/60" : suggested ? "border-ok/50" : "border-line";

  return (
    <div className={`min-w-0 rounded border bg-panel-2 ${border} ${used || suggested ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[13px] font-semibold text-fg">{card.name}</span>
        {alias && alias !== card.name.toLowerCase() && <span className="font-mono text-[11px] text-faint">as {alias}</span>}
        <span className={`rounded-sm border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider ${STATUS_CLS[card.status]}`}>
          {card.status}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider">
          {used ? (
            <span className="text-fg">used</span>
          ) : suggested ? (
            <span className="text-ok">should use</span>
          ) : (
            <span className="text-faint">not used</span>
          )}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="font-mono text-[11px] text-dim">
          grain: <span className="text-fg">{card.grain || "—"}</span>
        </div>
        {card.description && (
          <p className={`text-[12.5px] leading-snug ${flagged ? "text-fg" : "text-dim"}`}>
            <Highlighted text={card.description} marks={marks} activeId={activeId} onPick={onPick} />
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          {card.columns.map((c) => {
            const on = cols.has(c.name.toLowerCase());
            const dup = dups.has(c.name);
            return (
              <span
                key={c.name}
                title={c.type}
                className={`rounded-sm border px-1.5 py-px font-mono text-[10.5px] ${
                  dup
                    ? "border-bad/60 text-bad"
                    : on
                      ? "border-line-2 bg-fg/[0.06] text-fg"
                      : "border-line text-faint"
                }`}
              >
                {c.name}
              </span>
            );
          })}
        </div>
        {card.sampleRows && card.sampleRows.length > 0 && (
          <details open={dups.size > 0} className="group">
            <summary className="cursor-pointer select-none font-mono text-[10.5px] uppercase tracking-wider text-faint hover:text-dim">
              sample rows ({card.sampleRows.length})
              {dups.size > 0 && <span className="ml-2 normal-case tracking-normal text-bad">duplicate join keys</span>}
            </summary>
            <div className="mt-1.5 overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10.5px]">
                <thead>
                  <tr>
                    {Object.keys(card.sampleRows[0]).map((k) => (
                      <th key={k} className="border-b border-line px-1.5 py-1 text-left font-normal text-faint">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {card.sampleRows.map((r, i) => (
                    <tr key={i}>
                      {Object.keys(card.sampleRows![0]).map((k) => {
                        const v = String(r[k] ?? "");
                        const bad = dups.get(k)?.has(v);
                        return (
                          <td key={k} className={`whitespace-nowrap px-1.5 py-0.5 ${bad ? "bg-bad/15 text-bad" : "text-dim"}`}>
                            {v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** SQL with flagged spans, the question, and a card per table in the schema. */
export function SqlView({
  input,
  findings,
  activeId,
  onPick,
}: {
  input: QueryInput;
  findings: Finding[];
  activeId?: string | null;
  onPick?: PickHandler;
}) {
  const analysis = analyzeSql(input.sql, input.tables);
  const sqlMarks = marksFor(findings, ["sql"]);
  const schemaMarks = marksFor(findings, ["schema"]);
  const questionMarks = marksFor(findings, ["question"]);
  const usedCards = new Set(analysis.tables.map((t) => t.card).filter(Boolean));
  const suggestedNames = findings
    .filter((f) => f.suggestion || f.rule === "llm")
    .map((f) => `${f.suggestion ?? ""} ${f.detail}`.toLowerCase());
  const isSuggested = (c: TableCard) =>
    !usedCards.has(c) && suggestedNames.some((s) => new RegExp(`\\b${c.name.toLowerCase()}\\b`).test(s));
  const ordered = [...input.tables].sort(
    (a, b) => Number(usedCards.has(b)) - Number(usedCards.has(a)) || Number(isSuggested(b)) - Number(isSuggested(a)),
  );
  const lines = input.sql.split("\n").length;

  return (
    <div className="space-y-4">
      {input.question && (
        <div>
          <Label>Question</Label>
          <div className="rounded border border-line bg-panel-2 px-3 py-2 text-[14px]">
            <Highlighted text={input.question} marks={questionMarks} activeId={activeId} onPick={onPick} />
          </div>
        </div>
      )}
      <div>
        <Label>AI-generated SQL</Label>
        <div className="flex overflow-x-auto rounded border border-line bg-panel-2">
          <pre className="select-none border-r border-line px-2 py-3 text-right font-mono text-[12.5px] leading-relaxed text-faint">
            {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
          </pre>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-3 py-3 font-mono text-[12.5px] leading-relaxed text-fg">
            <Highlighted text={input.sql} marks={sqlMarks} activeId={activeId} onPick={onPick} />
          </pre>
        </div>
      </div>
      <div>
        <Label>Schema cards</Label>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {ordered.map((c) => (
            <SchemaCard
              key={c.name}
              card={c}
              analysis={analysis}
              used={usedCards.has(c)}
              suggested={isSuggested(c)}
              marks={schemaMarks}
              activeId={activeId}
              onPick={onPick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
