// Small, dependency-free text helpers shared by both auditors.

export type NumKind = "money" | "percent" | "year" | "number";

export type NumToken = {
  raw: string;
  value: number;
  /** Half of the last displayed digit — "14 million" is ±0.5M, "$14.2M" is ±0.05M. */
  tol: number;
  index: number;
  kind: NumKind;
};

const UNIT: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

const NUM_RE =
  /(?<![\w.\-])(\$|USD\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|thousand|mm|mn|million|m|bn|billion|b|trillion|t)\b)?(\s?%|\s?percent\b)?(?![\w])/gi;

/** Extract money / percents / years / plain numbers with their display precision. */
export function extractNumbers(text: string): NumToken[] {
  const out: NumToken[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const [raw, cur, intPart, dec, unitRaw, pct] = m;
    const unit = unitRaw ? UNIT[unitRaw.toLowerCase()] ?? 1 : 1;
    const base = parseFloat(intPart.replace(/,/g, "") + (dec ? "." + dec : ""));
    if (!Number.isFinite(base)) continue;
    const decimals = dec ? dec.length : 0;
    const value = base * unit;
    const tol = 0.5 * Math.pow(10, -decimals) * unit;
    let kind: NumKind = "number";
    if (pct) kind = "percent";
    else if (cur || unitRaw) kind = "money";
    else if (!dec && !intPart.includes(",") && base >= 1900 && base <= 2100) kind = "year";
    out.push({ raw: raw.trim(), value, tol, index: m.index ?? 0, kind });
  }
  return out;
}

/** Numbers worth grounding: skip tiny bare integers ("step 3", "2 tools"). */
export function isMaterial(n: NumToken): boolean {
  if (n.kind === "number") return n.value >= 100;
  return true;
}

/** Is `n` supported by any reference number, allowing for display rounding? */
export function isGrounded(n: NumToken, refs: NumToken[]): boolean {
  return refs.some((r) => {
    const tol = Math.max(n.tol, r.tol, 1e-9);
    if (Math.abs(r.value - n.value) <= tol) return true;
    // 12% vs 0.12
    if (n.kind === "percent" && Math.abs(r.value * 100 - n.value) <= tol) return true;
    return false;
  });
}

export type Sentence = { text: string; start: number };

/** Split on sentence punctuation followed by whitespace (so "$11.84M" survives) or on newlines. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const endPunct = /[.!?]/.test(ch) && (i + 1 === text.length || /\s/.test(text[i + 1]));
    if (endPunct || ch === "\n") {
      push(start, ch === "\n" ? i : i + 1);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;

  function push(a: number, b: number) {
    const raw = text.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: a + lead });
  }
}

/** From `start`, extend to the end of the clause (punctuation, ", ", or a conjunction). */
export function clauseEnd(text: string, start: number, max = 110): number {
  const rest = text.slice(start, start + max);
  const m = rest.match(/[.;!?](?=\s|$)|\n|,\s|\s(?:and|but|then|so|or)\s/);
  return start + (m?.index ?? rest.length);
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a, for stable receipt numbers. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Add figures an agent may legitimately compute from tool output: pairwise
 * sums, differences, ratios / percent changes, and the grand total.
 */
export function withDerived(refs: NumToken[]): NumToken[] {
  const base = Array.from(new Set(refs.filter((r) => r.kind !== "year" && r.value !== 0).map((r) => r.value))).slice(0, 30);
  const derived: number[] = [];
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      const [a, b] = [base[i], base[j]];
      derived.push(a + b, Math.abs(a - b), (a / b) * 100, (b / a) * 100, ((a - b) / b) * 100, ((b - a) / a) * 100);
    }
  }
  if (base.length > 2) derived.push(base.reduce((s, v) => s + v, 0));
  return [
    ...refs,
    ...derived.filter(Number.isFinite).map((value) => ({ raw: "", value, tol: 0, index: -1, kind: "number" as const })),
  ];
}
