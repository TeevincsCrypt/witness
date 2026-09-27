// Query Witness: flags AI-generated SQL that runs fine but answers the wrong
// question — stale tables, join fan-out, unbounded aggregates.

import type { AuditOptions, Evidence, Finding, QueryInput, Receipt, TableCard } from "./types";
import { analyzeSql, hasColumn, type ColumnRef, type SqlAnalysis } from "./sqlParse";
import {
  buildChecks,
  coerceLlmFindings,
  finalizeReceipt,
  levelOf,
  mergeFindings,
  parseLlmJson,
} from "./receipt";
import { listJoin, truncate } from "./text";

export { analyzeSql };

export const QUERY_CHECKS = [
  { id: "tables", label: "Tables resolve to schema" },
  { id: "columns", label: "Columns resolve to schema" },
  { id: "stale", label: "No deprecated / stale-twin tables" },
  { id: "grain", label: "Joins preserve grain (no fan-out)" },
  { id: "bounded", label: "Fact aggregates filtered by date/status" },
  { id: "intent", label: "Question intent matches table freshness" },
  { id: "groupby", label: "GROUP BY covers non-aggregated columns" },
];

const NAME_NOISE =
  /^(?:v\d+|legacy|old|new|crm|dim|fct|fact|stg|raw|tmp|bak|backup|current|latest|master|clean|final|copy|prod|dev|snapshot|archive|\d+)$/;
const FACT_GRAIN =
  /line|item|order|event|transaction|txn|payment|invoice|session|click|fact|log|shipment|visit|charge|sale/i;
const FILTER_COLUMN = /date|_at$|_on$|time|day|month|year|period|status|state/i;
const CURRENT_INTENT = /\b(?:current|currently|active|latest|today|now|live|this (?:week|month|quarter|year))\b/i;
const STALE_WORDS = /\b(?:do not use|deprecated|obsolete|legacy)\b/i;

function singular(w: string): string {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** customers_v1, customers_crm, dim_customers → "customer" */
export function entityOf(name: string): string {
  const base = name.toLowerCase().split(".").pop() ?? name;
  return base
    .split(/_+/)
    .filter((t) => t && !NAME_NOISE.test(t))
    .map(singular)
    .join("_");
}

const grainKey = (card: TableCard) => singular(card.grain.trim().toLowerCase().replace(/[\s-]+/g, "_"));

function isStale(card: TableCard): boolean {
  return card.status === "deprecated" || (card.status === "unknown" && STALE_WORDS.test(card.description));
}

function sampleMultiplicity(card: TableCard, column: string): number | null {
  const rows = card.sampleRows;
  if (!rows || rows.length < 2) return null;
  const vals = rows.map((r) => r[column]).filter((v) => v !== undefined && v !== null);
  if (vals.length < 2) return null;
  const distinct = new Set(vals.map((v) => String(v))).size;
  return vals.length / distinct;
}

/** Is `card` one row per value of `column`? undefined when the grain is unknown. */
export function isUniqueOn(card: TableCard, column: string): boolean | undefined {
  const g = grainKey(card);
  if (!g) return undefined;
  const c = column.toLowerCase();
  if (/duplicat/i.test(card.description)) return false;
  const mult = sampleMultiplicity(card, column);
  if (mult !== null && mult > 1) return false;
  return c === `${g}_id` || c === `${g}id` || c === g || c === "id";
}

export function isFact(card: TableCard): boolean {
  return FACT_GRAIN.test(card.grain) || /^(?:fct|fact)_/i.test(card.name);
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const isSubsequence = (short: string, long: string) => {
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
};

function closest(name: string, options: string[]): string | undefined {
  const n = name.toLowerCase();
  // "amt" → "amount": abbreviations are subsequences sharing the first letter.
  const abbrev = options
    .filter((o) => o.toLowerCase()[0] === n[0] && isSubsequence(n, o.toLowerCase()))
    .sort((a, b) => a.length - b.length)[0];
  if (abbrev) return abbrev;
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = editDistance(name.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best && bestD <= Math.max(3, Math.floor(name.length / 2)) ? best : undefined;
}

/** Deterministic Query Witness rules. Pure; safe to run in the browser. */
export function auditQueryRules(input: QueryInput, analysis: SqlAnalysis = analyzeSql(input.sql, input.tables)): Finding[] {
  const findings: Finding[] = [];
  const a = analysis;
  const physical = a.tables.filter((t) => !t.isCte);

  // 1a. Unknown tables — the model invented schema.
  const unknownSeen = new Set<string>();
  for (const t of physical) {
    if (t.card || unknownSeen.has(t.name.toLowerCase())) continue;
    unknownSeen.add(t.name.toLowerCase());
    const near = closest(t.name, input.tables.map((c) => c.name));
    findings.push({
      id: `q-tables-${unknownSeen.size}`,
      severity: "INVENT",
      title: `Unknown table: ${t.name}`,
      detail: `"${t.name}" is not in the provided schema. The query references a table that does not exist in the catalog.`,
      evidence: [{ quote: t.quote, source: "sql" }],
      suggestion: near ? `Did you mean ${near}?` : "Use a table from the schema.",
      origin: "rule",
      rule: "tables",
      headline: `references a table that doesn't exist (${t.name})`,
    });
  }

  // 1b. Unknown columns on known tables.
  const colSeen = new Set<string>();
  for (const c of a.columns) {
    if (c.known || !c.card) continue;
    const key = `${c.card.name}.${c.column}`.toLowerCase();
    if (colSeen.has(key)) continue;
    colSeen.add(key);
    const near = closest(c.column, c.card.columns.map((x) => x.name));
    findings.push({
      id: `q-columns-${colSeen.size}`,
      severity: "INVENT",
      title: `Unknown column: ${c.raw}`,
      detail: `${c.card.name} has no column "${c.column}". Columns: ${c.card.columns.map((x) => x.name).join(", ")}.`,
      evidence: [{ quote: c.raw, source: "sql" }],
      suggestion: near ? `Did you mean ${c.qualifier}.${near}?` : undefined,
      origin: "rule",
      rule: "columns",
      headline: `references a column that doesn't exist (${c.raw})`,
    });
  }

  // 2. Stale twin: deprecated table used while a canonical table covers the same entity.
  const staleUsed = physical.filter((t) => t.card && isStale(t.card));
  const staleDone = new Set<string>();
  for (const t of staleUsed) {
    const card = t.card!;
    if (staleDone.has(card.name)) continue;
    staleDone.add(card.name);
    const twin = input.tables.find(
      (o) => o !== card && o.status === "canonical" && entityOf(o.name) === entityOf(card.name),
    );
    const evidence: Evidence[] = [
      { quote: t.quote, source: "sql" },
      { quote: card.description, source: "schema" },
    ];
    findings.push({
      id: `q-stale-${staleDone.size}`,
      severity: "SILENT_FAIL",
      title: twin ? `Stale twin: ${card.name} used instead of ${twin.name}` : `Deprecated table: ${card.name}`,
      detail: twin
        ? `${card.name} is ${card.status} ("${card.description}"). Its canonical twin ${twin.name} (grain=${twin.grain}) covers the same entity. The query runs and returns plausible numbers from the wrong source.`
        : `${card.name} is marked ${card.status}: "${card.description}"`,
      evidence: evidence.filter((e) => e.quote),
      suggestion: twin ? `Replace ${card.name} with ${twin.name}.` : `Find the canonical replacement for ${card.name}.`,
      origin: "rule",
      rule: "stale",
      headline: twin
        ? `reads deprecated ${card.name} instead of canonical ${twin.name}`
        : `reads deprecated ${card.name}`,
    });
  }

  // 3. Grain clash: a join where neither side is unique on the key fans out rows.
  const inflating = a.aggregates.filter((g) => !g.distinct && g.fn !== "MIN" && g.fn !== "MAX");
  const grainDone = new Set<string>();
  for (const j of a.joins) {
    for (const { left, right } of j.pairs) {
      if (!left.card || !right.card || left.card === right.card) continue;
      const lu = isUniqueOn(left.card, left.column);
      const ru = isUniqueOn(right.card, right.column);
      if (lu === undefined || ru === undefined || lu || ru) continue;
      const key = [left.card.name, right.card.name].sort().join("|");
      if (grainDone.has(key)) continue;
      grainDone.add(key);
      findings.push(grainFinding(j.quote, left, right, inflating, grainDone.size));
    }
  }

  // 4. Aggregates over a fact table with no date or status filter.
  const whereText = a.where?.text ?? "";
  const factDone = new Set<string>();
  for (const t of physical) {
    const card = t.card;
    if (!card || !isFact(card) || factDone.has(card.name)) continue;
    const aggs = a.aggregates.filter((g) => g.args.some((c) => c.card === card) || (g.star && physical.length === 1));
    if (aggs.length === 0) continue;
    factDone.add(card.name);
    const filterCols = card.columns.filter((c) => FILTER_COLUMN.test(c.name) || /date|time/i.test(c.type));
    if (filterCols.length === 0) continue;
    const filtered = filterCols.some((c) =>
      new RegExp(`(?:\\b${t.alias}\\.|\\b${card.name}\\.|(?<![\\w.]))${c.name}\\b`, "i").test(whereText),
    );
    if (filtered) continue;
    const names = filterCols.map((c) => c.name);
    findings.push({
      id: `q-bounded-${factDone.size}`,
      severity: "SILENT_FAIL",
      title: `Unbounded aggregate on ${card.name}`,
      detail: `${aggs.map((g) => g.raw).join(", ")} runs over every row of ${card.name} (grain=${card.grain}) — no filter on ${listJoin(names)}. All history and every status (refunded, cancelled, test) are included.`,
      evidence: [
        ...aggs.map((g) => ({ quote: g.raw, source: "sql" as const })),
        ...(a.where ? [{ quote: a.where.quote, source: "sql" as const }] : []),
      ],
      suggestion: `Filter on ${names.map((n) => `${t.alias}.${n}`).join(" / ")} (e.g. status = 'paid' and a date range).`,
      level: "warn",
      origin: "rule",
      rule: "bounded",
      headline: `sums every status and date in ${card.name}`,
    });
  }

  // 5. The question asks for current data; the query reads a legacy table.
  const q = input.question?.trim() ?? "";
  const intentM = q.match(CURRENT_INTENT);
  if (intentM && staleUsed.length) {
    const t = staleUsed[0];
    findings.push({
      id: "q-intent",
      severity: "SILENT_FAIL",
      title: `Intent mismatch: "${intentM[0].toLowerCase()}" question, legacy table`,
      detail: `The question asks for "${intentM[0]}" data, but the answer comes from ${t.card!.name}: "${t.card!.description}"`,
      evidence: [
        { quote: q, source: "question" },
        { quote: t.quote, source: "sql" },
      ],
      suggestion: "Route freshness-sensitive questions to canonical tables only.",
      origin: "rule",
      rule: "intent",
      headline: `answers a "${intentM[0].toLowerCase()}" question from a legacy table`,
    });
  }

  // 6. Aggregates next to bare columns with no GROUP BY.
  if (a.aggregates.length && !a.hasGroupBy && a.select) {
    const bare = a.selectItems.filter(
      (s) =>
        !/\b(?:sum|count|avg|min|max)\s*\(/i.test(s) &&
        !/\bover\s*\(/i.test(s) &&
        !/^(?:\*|[\d.]+|'[^']*'|null|true|false)(?:\s+(?:as\s+)?\w+)?$/i.test(s.trim()),
    );
    if (bare.length) {
      findings.push({
        id: "q-groupby",
        severity: "SILENT_FAIL",
        title: "Missing GROUP BY",
        detail: `${listJoin(bare.map((b) => truncate(b.trim(), 40)))} is selected next to an aggregate with no GROUP BY. Strict engines reject it; permissive ones (MySQL without ONLY_FULL_GROUP_BY) silently return one row with an arbitrary ${bare[0].trim()}.`,
        evidence: [{ quote: a.select.quote, source: "sql" }],
        suggestion: `Add GROUP BY ${bare.map((b) => b.trim().replace(/\s+(?:as\s+)?\w+$/i, "")).join(", ")}.`,
        origin: "rule",
        rule: "groupby",
        headline: `has no GROUP BY for ${bare.map((b) => b.trim()).join(", ")}`,
      });
    }
  }

  return findings;
}

function grainFinding(
  joinQuote: string,
  left: ColumnRef,
  right: ColumnRef,
  aggs: SqlAnalysis["aggregates"],
  n: number,
): Finding {
  const L = left.card!;
  const R = right.card!;
  const measured = aggs.find((g) => g.args.some((c) => c.card === L || c.card === R));
  // SUM over table M is inflated by the multiplicity of the *other* side.
  let factor: number | null = null;
  let factorNote = "";
  if (measured) {
    const mCard = measured.args.find((c) => c.card === L || c.card === R)!.card!;
    const other = mCard === L ? { card: R, col: right.column } : { card: L, col: left.column };
    factor = sampleMultiplicity(other.card, other.col);
    if (factor && factor > 1)
      factorNote = ` Sample rows show ${factor.toFixed(1)} rows per ${other.col} in ${other.card.name}, so every ${mCard.name} row is counted ~${factor.toFixed(1)}×.`;
  }
  const dupDesc = [L, R].find((c) => /duplicat/i.test(c.description));
  const evidence: Evidence[] = [{ quote: joinQuote, source: "sql" }];
  if (measured) evidence.push({ quote: measured.raw, source: "sql" });
  if (dupDesc) {
    const m = dupDesc.description.match(/[^.]*duplicat[^.]*\.?/i);
    evidence.push({ quote: (m?.[0] ?? dupDesc.description).trim(), source: "schema" });
  }
  const failing = !!measured;
  return {
    id: `q-grain-${n}`,
    severity: "SILENT_FAIL",
    title: `Grain clash: ${L.name} (${L.grain}) × ${R.name} (${R.grain})`,
    detail: `Joined on ${left.raw} = ${right.raw}, but ${L.name} is one row per ${L.grain} and ${R.name} is one row per ${R.grain} — neither is unique on the key, so rows multiply.${measured ? ` ${measured.raw} double-counts.` : ""}${factorNote}`,
    evidence,
    suggestion: "Join through a table that is unique on the key, or pre-aggregate each side to the key's grain before joining.",
    level: failing ? "fail" : "warn",
    origin: "rule",
    rule: "grain",
    headline: `its ${left.column} join fans out (${L.grain} × ${R.grain}) so ${measured?.raw ?? "the result"} is inflated${factor && factor > 1 ? ` ~${factor.toFixed(1)}×` : ""}`,
  };
}

export function querySummary(verdict: "PASS" | "FAIL", findings: Finding[]): string {
  const warns = findings.filter((f) => levelOf(f) === "warn");
  if (verdict === "PASS") {
    return warns.length
      ? `PASS with ${warns.length} advisory note${warns.length > 1 ? "s" : ""} — tables are canonical and joins preserve grain; review the flagged lines.`
      : "PASS — every table is canonical and resolves to the schema, joins preserve grain, and aggregates are bounded.";
  }
  const rules = new Set(findings.map((f) => f.rule));
  const heads = findings
    .filter((f) => f.origin === "rule" && f.headline)
    // the intent finding restates the stale-twin finding
    .filter((f) => !(f.rule === "intent" && rules.has("stale")))
    .map((f) => f.headline!);
  return heads.length
    ? `FAIL — the SQL runs, but it ${listJoin(heads)}.`
    : `FAIL — ${findings[0]?.title ?? "query failed audit"}.`;
}

const QUERY_SYSTEM = `You are WITNESS, an auditor of AI-generated SQL.
You receive table cards (name, status, grain, description, columns, sample rows), a business question, and a SQL query that already executes.
Find semantic errors that still run: wrong or deprecated table, join fan-out from grain mismatch, missing filters, wrong aggregation, mismatch with the question.
Answer in one sentence: what would make this number 2x too high? Which table should have been used?
Return JSON only, no prose, matching:
{"twoXCause": string (one sentence), "shouldUseTable": string | null, "summary": string (one sentence), "findings": [{"severity": "INVENT"|"SILENT_FAIL"|"OVERRIDE"|"HIDE", "title": string (max 8 words), "detail": string, "evidence": [{"quote": string (copied VERBATIM from the SQL, question, or schema), "source": "sql"|"schema"|"question"}], "suggestion": string}]}
If the query is correct, return an empty findings array.`;

export async function auditQuery(input: QueryInput, opts: AuditOptions = {}): Promise<Receipt> {
  const analysis = analyzeSql(input.sql, input.tables);
  const rules = auditQueryRules(input, analysis);
  let findings = rules;
  let llmState: "off" | "ok" | "error" = "off";
  let llmNote: string | undefined;
  let twoX: string | undefined;

  if (opts.llm) {
    try {
      const text = await opts.llm(QUERY_SYSTEM, JSON.stringify(input, null, 2));
      const parsed = parseLlmJson(text);
      if (!parsed) throw new Error("model output was not JSON");
      const haystack = [input.sql, input.question ?? "", JSON.stringify(input.tables)].join("\n");
      const { findings: llmFindings, dropped } = coerceLlmFindings(parsed.findings, {
        prefix: "q",
        sources: ["sql", "schema", "question"],
        haystack,
      });
      findings = mergeFindings(rules, llmFindings);
      const added = findings.length - rules.length;
      if (typeof parsed.twoXCause === "string" && parsed.twoXCause.trim()) {
        twoX = parsed.twoXCause.trim();
        const should =
          typeof parsed.shouldUseTable === "string"
            ? input.tables.find((t) => t.name.toLowerCase() === String(parsed.shouldUseTable).toLowerCase())
            : undefined;
        findings.push({
          id: "q-llm-2x",
          severity: rules.some((f) => levelOf(f) === "fail") ? "SILENT_FAIL" : "PASS",
          title: "What would make this number 2× too high",
          detail: twoX + (should ? ` Should use: ${should.name}.` : ""),
          evidence: should ? [{ quote: should.name, source: "schema" }] : [],
          level: "info",
          origin: "llm",
          rule: "llm",
        });
      }
      llmState = "ok";
      llmNote = `LLM added ${added} advisory finding${added === 1 ? "" : "s"}${dropped ? `; dropped ${dropped} without verbatim evidence` : ""}.`;
    } catch (e) {
      llmState = "error";
      llmNote = `LLM pass skipped (${e instanceof Error ? e.message : "error"}); rule findings kept.`;
    }
  }

  const hasGrain = analysis.joins.length > 0;
  const hasAgg = analysis.aggregates.length > 0;
  return finalizeReceipt({
    module: "query",
    input,
    findings,
    summary: (verdict, fs) => querySummary(verdict, fs) + (twoX ? ` LLM: ${twoX}` : ""),
    checks: buildChecks(
      QUERY_CHECKS,
      findings,
      [
        ...(hasGrain ? [] : ["grain"]),
        ...(hasAgg ? [] : ["bounded", "groupby"]),
        ...(input.question?.trim() ? [] : ["intent"]),
      ],
    ),
    meta: { llm: llmState, llmModel: opts.llmModel, llmNote },
  });
}

/** Columns of `card` that the SQL touches — used by the schema cards in the UI. */
export function usedColumns(analysis: SqlAnalysis, card: TableCard): Set<string> {
  return new Set(
    analysis.columns.filter((c) => c.card === card && hasColumn(card, c.column)).map((c) => c.column.toLowerCase()),
  );
}
