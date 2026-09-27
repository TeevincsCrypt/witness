// Splits text into segments so evidence quotes can be rendered as marks.

import type { EvidenceSource, Finding, Level } from "./types";

export type Mark = { quote: string; findingId: string; level: Level; title: string };
export type Segment = { text: string; marks: Mark[] };

export function marksFor(findings: Finding[], sources: EvidenceSource[]): Mark[] {
  return findings.flatMap((f) =>
    f.evidence
      .filter((e) => sources.includes(e.source))
      .map((e) => ({ quote: e.quote, findingId: f.id, level: f.level ?? "fail", title: f.title })),
  );
}

export function segment(text: string, marks: Mark[]): Segment[] {
  const lower = text.toLowerCase();
  const ranges: { start: number; end: number; mark: Mark }[] = [];
  for (const m of marks) {
    const q = m.quote.trim().replace(/…$/, "").toLowerCase();
    if (q.length < 2) continue;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(q, from);
      if (idx < 0) break;
      ranges.push({ start: idx, end: idx + q.length, mark: m });
      from = idx + q.length;
    }
  }
  if (ranges.length === 0) return [{ text, marks: [] }];
  const cuts = Array.from(new Set([0, text.length, ...ranges.flatMap((r) => [r.start, r.end])])).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    if (a === b) continue;
    const ms = ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.mark);
    const prev = out[out.length - 1];
    const same = prev && prev.marks.length === ms.length && prev.marks.every((m, i) => m === ms[i]);
    if (same) prev.text += text.slice(a, b);
    else out.push({ text: text.slice(a, b), marks: ms });
  }
  return out;
}
