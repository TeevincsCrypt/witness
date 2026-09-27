// Scoring, merging and LLM-output handling shared by both modules.

import type {
  Check,
  Evidence,
  EvidenceSource,
  Finding,
  Level,
  Receipt,
  ReceiptMeta,
  Severity,
} from "./types";
import { fnv1a, normalize } from "./text";

export const RULES_VERSION = "rules v1";

const WEIGHT: Record<Severity, number> = {
  PASS: 0,
  HIDE: 0.9,
  INVENT: 0.85,
  SILENT_FAIL: 0.8,
  OVERRIDE: 0.75,
};

const LEVEL_MULT: Record<Level, number> = { fail: 1, warn: 0.4, info: 0 };

export const levelOf = (f: Finding): Level => f.level ?? "fail";

/** Noisy-OR of finding weights. 0 = clean, →1 = certain failure. */
export function scoreFindings(findings: Finding[]): number {
  let clean = 1;
  for (const f of findings) clean *= 1 - WEIGHT[f.severity] * LEVEL_MULT[levelOf(f)];
  return Math.round(Math.min(0.99, 1 - clean) * 100) / 100;
}

/** Deterministic fail-level findings gate the verdict; advisories only fail it in bulk. */
export function verdictOf(findings: Finding[], score: number): "PASS" | "FAIL" {
  return findings.some((f) => levelOf(f) === "fail") || score >= 0.7 ? "FAIL" : "PASS";
}

const LEVEL_RANK: Record<Level, number> = { fail: 0, warn: 1, info: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)] ||
      WEIGHT[b.severity] - WEIGHT[a.severity],
  );
}

function quotesOverlap(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < 3 || y.length < 3) return false;
  return x.includes(y) || y.includes(x);
}

/** rule findings ∪ LLM findings, deduped by title and by overlapping evidence. */
export function mergeFindings(rule: Finding[], llm: Finding[]): Finding[] {
  const out = [...rule];
  for (const f of llm) {
    const title = normalize(f.title);
    const dup = out.some(
      (g) =>
        normalize(g.title) === title ||
        g.evidence.some((ge) => f.evidence.some((fe) => quotesOverlap(ge.quote, fe.quote))),
    );
    if (!dup) out.push(f);
  }
  return out;
}

export function buildChecks(
  defs: { id: string; label: string }[],
  findings: Finding[],
  skipped: string[] = [],
): Check[] {
  return defs.map(({ id, label }) => {
    if (skipped.includes(id)) return { id, label, status: "skip" };
    const hits = findings.filter((f) => f.rule === id);
    const status = hits.some((f) => levelOf(f) === "fail")
      ? "fail"
      : hits.some((f) => levelOf(f) === "warn")
        ? "warn"
        : "pass";
    return { id, label, status };
  });
}

export function finalizeReceipt(args: {
  module: Receipt["module"];
  input: unknown;
  findings: Finding[];
  summary: (verdict: "PASS" | "FAIL", findings: Finding[]) => string;
  checks: Check[];
  meta: Pick<ReceiptMeta, "llm" | "llmModel" | "llmNote">;
}): Receipt {
  const findings = sortFindings(args.findings);
  const score = scoreFindings(findings);
  const verdict = verdictOf(findings, score);
  const llmUsed = args.meta.llm === "ok";
  return {
    module: args.module,
    score,
    verdict,
    findings,
    summary: args.summary(verdict, findings),
    checks: args.checks,
    meta: {
      receiptNo: "W-" + fnv1a(JSON.stringify(args.input)),
      createdAt: new Date().toISOString(),
      auditor: llmUsed && args.meta.llmModel ? `${RULES_VERSION} + ${args.meta.llmModel}` : RULES_VERSION,
      ...args.meta,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM output handling. The model is never trusted: output must parse as JSON,
// every finding must quote the input verbatim, and LLM-only findings are
// advisory (warn) so a chatty model cannot flip a clean receipt on its own.
// ---------------------------------------------------------------------------

/** Parse model text as JSON, tolerating ```json fences and leading prose. */
export function parseLlmJson(text: string): Record<string, unknown> | null {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const SEVERITIES: Severity[] = ["PASS", "HIDE", "INVENT", "OVERRIDE", "SILENT_FAIL"];

export function coerceLlmFindings(
  raw: unknown,
  opts: { prefix: string; sources: EvidenceSource[]; haystack: string },
): { findings: Finding[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const hay = normalize(opts.haystack);
  const findings: Finding[] = [];
  let dropped = 0;
  list.forEach((item, idx) => {
    if (!item || typeof item !== "object") return void dropped++;
    const r = item as Record<string, unknown>;
    const sevRaw = String(r.severity ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    const severity = SEVERITIES.find((s) => s === sevRaw);
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!severity || severity === "PASS" || !title) return void dropped++;
    const evidence: Evidence[] = (Array.isArray(r.evidence) ? r.evidence : [])
      .map((e): Evidence | null => {
        if (!e || typeof e !== "object") return null;
        const ev = e as Record<string, unknown>;
        const quote = typeof ev.quote === "string" ? ev.quote.trim() : "";
        if (quote.length < 3 || !hay.includes(normalize(quote))) return null;
        const src = opts.sources.find((s) => s === ev.source) ?? opts.sources[0];
        return { quote, source: src };
      })
      .filter((e): e is Evidence => e !== null);
    // Ungrounded claims about the input are exactly the failure we audit for.
    if (evidence.length === 0) return void dropped++;
    findings.push({
      id: `${opts.prefix}-llm-${idx + 1}`,
      severity,
      title: title.slice(0, 90),
      detail: typeof r.detail === "string" ? r.detail : "",
      evidence,
      suggestion: typeof r.suggestion === "string" ? r.suggestion : undefined,
      level: "warn",
      origin: "llm",
      rule: "llm",
    });
  });
  return { findings, dropped };
}
