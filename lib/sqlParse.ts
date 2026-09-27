// Regex-level SQL analysis. Not a full parser — just enough structure to
// resolve tables, columns, joins and aggregates against table cards.
// Comments and string literals are masked with spaces so every index still
// points into the original SQL (used to quote exact evidence).

import type { TableCard } from "./types";

export type TableRef = {
  name: string;
  alias: string;
  card?: TableCard;
  isCte: boolean;
  start: number;
  end: number;
  quote: string; // e.g. "FROM customers_v1 c"
};

export type ColumnRef = {
  qualifier: string;
  column: string;
  card?: TableCard;
  known: boolean;
  index: number;
  raw: string; // e.g. "o.amount"
};

export type JoinRef = {
  quote: string; // e.g. "JOIN orders o ON c.customer_id = o.customer_id"
  start: number;
  pairs: { left: ColumnRef; right: ColumnRef }[];
};

export type Aggregate = {
  fn: string;
  distinct: boolean;
  raw: string; // e.g. "SUM(o.amount)"
  args: ColumnRef[];
  star: boolean;
  index: number;
};

export type Clause = { text: string; quote: string; start: number; end: number };

export type SqlAnalysis = {
  tables: TableRef[];
  columns: ColumnRef[];
  joins: JoinRef[];
  aggregates: Aggregate[];
  where: Clause | null; // top-level WHERE (for evidence)
  whereText: string; // every WHERE clause at any depth (CTEs, subqueries) — for filter detection
  select: Clause | null;
  selectItems: string[];
  hasGroupBy: boolean;
  ctes: string[];
};

const KEYWORDS = new Set(
  (
    "select from where join inner left right full outer cross natural on using group order by having limit " +
    "offset union all except intersect as and or not in is null like between case when then else end with " +
    "distinct lateral qualify window over partition asc desc fetch first rows only set values"
  ).split(" "),
);

/** Non-column words that can appear bare in SQL: types, date parts, literals, clause words. */
const SQL_WORDS = new Set(
  (
    "date time timestamp timestamptz interval true false null current_date current_time current_timestamp " +
    "localtime localtimestamp day days month months year years week weeks quarter hour minute second epoch dow doy " +
    "varchar char text int integer bigint smallint decimal numeric float double real boolean bool string " +
    "nulls last filter within rows range preceding following unbounded current row exists any some top ilike " +
    "extract cast recursive materialized"
  ).split(" "),
);

/** Replace comments and string-literal contents with spaces, preserving length and newlines. */
export function maskSql(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const e = sql.indexOf("\n", i);
      const end = e < 0 ? sql.length : e;
      blank(i, end);
      i = end;
    } else if (two === "/*") {
      const e = sql.indexOf("*/", i + 2);
      const end = e < 0 ? sql.length : e + 2;
      blank(i, end);
      i = end;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (sql[i] === '"' || sql[i] === "`") {
      out[i] = " "; // quoted identifiers → bare identifiers
      i++;
    } else i++;
  }
  return out.join("");
}

function depthMap(masked: string): number[] {
  const d: number[] = new Array(masked.length);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    d[i] = depth;
    if (masked[i] === ")") depth = Math.max(0, depth - 1);
  }
  return d;
}

function findTopLevel(masked: string, depth: number[], re: RegExp, from = 0): RegExpMatchArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  g.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = g.exec(masked))) {
    if ((depth[m.index] ?? 0) === 0) return m;
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

export function findCard(tables: TableCard[], name: string): TableCard | undefined {
  const n = name.toLowerCase();
  const last = n.split(".").pop() ?? n;
  return (
    tables.find((t) => t.name.toLowerCase() === n) ??
    tables.find((t) => (t.name.toLowerCase().split(".").pop() ?? "") === last)
  );
}

export function hasColumn(card: TableCard, column: string): boolean {
  const c = column.toLowerCase();
  return c === "*" || card.columns.some((col) => col.name.toLowerCase() === c);
}

export function analyzeSql(sql: string, tables: TableCard[]): SqlAnalysis {
  const masked = maskSql(sql);
  const depth = depthMap(masked);
  const quoteOf = (a: number, b: number) => sql.slice(a, b).trim();

  // CTE names are not physical tables.
  const ctes: string[] = [];
  if (/^\s*with\b/i.test(masked)) {
    for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\s+as\s*\(/gi)) ctes.push(m[1].toLowerCase());
  }

  // FROM / JOIN table references (plus comma-separated FROM lists).
  const tablesOut: TableRef[] = [];
  const ident = "([A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*)";
  const aliasPart = "(?:\\s+(?:as\\s+)?([A-Za-z_]\\w*))?";
  const refRe = new RegExp(`\\b(from|join)\\s+${ident}${aliasPart}`, "gi");
  const pushRef = (kwStart: number, name: string, alias: string | undefined, nameEnd: number, fullEnd: number) => {
    if (/^\s*\(/.test(masked.slice(nameEnd))) return; // table function, e.g. unnest(...)
    const aliasOk = alias && !KEYWORDS.has(alias.toLowerCase());
    const end = aliasOk ? fullEnd : nameEnd;
    tablesOut.push({
      name,
      alias: (aliasOk ? alias : name.split(".").pop() ?? name).toLowerCase(),
      card: findCard(tables, name),
      isCte: ctes.includes(name.toLowerCase()),
      start: kwStart,
      end,
      quote: quoteOf(kwStart, end),
    });
  };
  // "FROM" inside EXTRACT(year FROM x) / TRIM(... FROM x) is not a table reference.
  const inSelectScope = (i: number) => {
    let d = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (masked[k] === ")") d++;
      else if (masked[k] === "(" && d-- === 0) return /\bselect\b/i.test(masked.slice(k, i));
    }
    return true;
  };
  const listRe = new RegExp(`^\\s*,\\s*${ident}${aliasPart}`, "i");
  for (const m of masked.matchAll(refRe)) {
    const start = m.index ?? 0;
    if (!inSelectScope(start)) continue;
    const nameStart = start + m[0].indexOf(m[2], m[1].length);
    pushRef(start, m[2], m[3], nameStart + m[2].length, start + m[0].length);
    if (m[1].toLowerCase() !== "from") continue;
    // FROM a x, b y
    let cursor = tablesOut[tablesOut.length - 1]?.end ?? start + m[0].length;
    let lm: RegExpMatchArray | null;
    while ((lm = masked.slice(cursor).match(listRe))) {
      const s0 = cursor + lm[0].indexOf(lm[1]);
      const before = tablesOut.length;
      pushRef(s0, lm[1], lm[2], s0 + lm[1].length, cursor + lm[0].length);
      if (tablesOut.length === before) break;
      cursor = tablesOut[tablesOut.length - 1].end;
    }
  }

  const byAlias = new Map<string, TableRef>();
  for (const t of tablesOut) {
    byAlias.set(t.alias, t);
    byAlias.set(t.name.toLowerCase(), t);
  }
  const inTableRef = (i: number) => tablesOut.some((t) => i >= t.start && i < t.end);

  const resolve = (qualifier: string, column: string, index: number, raw: string): ColumnRef | null => {
    const ref = byAlias.get(qualifier.toLowerCase());
    if (!ref) return null;
    return {
      qualifier,
      column,
      card: ref.card,
      known: ref.card ? hasColumn(ref.card, column) : true,
      index,
      raw,
    };
  };

  // Qualified column references: alias.column
  const columns: ColumnRef[] = [];
  for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\.\s?([A-Za-z_]\w*|\*)/g)) {
    const idx = m.index ?? 0;
    if (inTableRef(idx)) continue;
    const c = resolve(m[1], m[2], idx, sql.slice(idx, idx + m[0].length));
    if (c) columns.push(c);
  }

  // JOIN clauses with their ON equality pairs.
  const joins: JoinRef[] = [];
  const stopRe = /\b(?:left|right|full|inner|cross|natural|join|where|group\s+by|order\s+by|limit|having|union|qualify|window)\b|;|\)/gi;
  for (const m of masked.matchAll(/\b(?:(?:left|right|full|inner|cross)\s+(?:outer\s+)?)?join\b/gi)) {
    const start = m.index ?? 0;
    const ref = tablesOut.find((t) => t.start >= start && t.start <= start + m[0].length + 1);
    const bodyFrom = ref ? ref.end : start + m[0].length;
    stopRe.lastIndex = bodyFrom;
    let end = masked.length;
    let sm: RegExpExecArray | null;
    while ((sm = stopRe.exec(masked))) {
      if ((depth[sm.index] ?? 0) <= (depth[start] ?? 0)) {
        end = sm.index;
        break;
      }
    }
    const body = masked.slice(start, end);
    const pairs: JoinRef["pairs"] = [];
    for (const pm of body.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) {
      const base = start + (pm.index ?? 0);
      const l = resolve(pm[1], pm[2], base, `${pm[1]}.${pm[2]}`);
      const r = resolve(pm[3], pm[4], base, `${pm[3]}.${pm[4]}`);
      if (l && r) pairs.push({ left: l, right: r });
    }
    const using = body.match(/\busing\s*\(([^)]*)\)/i);
    if (using && ref) {
      const leftRef = tablesOut.find((t) => t !== ref && t.start < start);
      if (leftRef) {
        for (const col of using[1].split(",").map((c) => c.trim()).filter(Boolean)) {
          const l = resolve(leftRef.alias, col, start, `${leftRef.alias}.${col}`);
          const r = resolve(ref.alias, col, start, `${ref.alias}.${col}`);
          if (l && r) pairs.push({ left: l, right: r });
        }
      }
    }
    joins.push({ quote: quoteOf(start, end), start, pairs });
  }

  // SELECT list, WHERE, GROUP BY (top level only).
  const selM = findTopLevel(masked, depth, /\bselect\b/i);
  const fromM = selM ? findTopLevel(masked, depth, /\bfrom\b/i, (selM.index ?? 0) + 6) : null;
  let select: Clause | null = null;
  let selectItems: string[] = [];
  if (selM && fromM) {
    const a = selM.index ?? 0;
    const b = fromM.index ?? 0;
    select = { text: masked.slice(a, b), quote: quoteOf(a, b), start: a, end: b };
    const list = masked.slice(a + selM[0].length, b);
    let d = 0;
    let cur = "";
    for (const ch of list) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) {
        selectItems.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) selectItems.push(cur.trim());
    selectItems = selectItems.map((s) => s.replace(/^distinct\s+/i, ""));
  }

  // Bare (unqualified) columns. Resolved when exactly one table has the column;
  // in a single-table query, any other bare identifier is a hallucinated column.
  const physicalRefs = tablesOut.filter((t) => t.card && !t.isCte);
  const singleTable =
    tablesOut.length === 1 && physicalRefs.length === 1 && (masked.match(/\bselect\b/gi) ?? []).length === 1;
  const aliases = new Set([...masked.matchAll(/\bas\s+([A-Za-z_]\w*)/gi)].map((m) => m[1].toLowerCase()));
  for (const item of selectItems) {
    const implicit = item.match(/[\w)]\s+([A-Za-z_]\w*)$/); // "SUM(x) total"
    if (implicit && !KEYWORDS.has(implicit[1].toLowerCase())) aliases.add(implicit[1].toLowerCase());
  }
  const refNames = new Set(tablesOut.flatMap((t) => [t.alias, t.name.toLowerCase()]));
  for (const m of masked.matchAll(/(?<!\.\s?)(?<![\w$:])([A-Za-z_]\w*)\b(?!\s*\()(?!\s*\.)/g)) {
    const idx = m.index ?? 0;
    const id = m[1].toLowerCase();
    if (inTableRef(idx) || KEYWORDS.has(id) || SQL_WORDS.has(id) || aliases.has(id) || refNames.has(id)) continue;
    if (ctes.includes(id)) continue;
    const owners = physicalRefs.filter((t) => hasColumn(t.card!, id));
    if (owners.length === 1) {
      columns.push({ qualifier: owners[0].alias, column: m[1], card: owners[0].card, known: true, index: idx, raw: m[1] });
    } else if (owners.length === 0 && singleTable) {
      columns.push({ qualifier: "", column: m[1], card: physicalRefs[0].card, known: false, index: idx, raw: m[1] });
    }
  }
  columns.sort((x, y) => x.index - y.index);

  // Aggregates, with balanced-paren argument extraction.
  const aggregates: Aggregate[] = [];
  for (const m of masked.matchAll(/\b(sum|count|avg|min|max)\s*\(/gi)) {
    const idx = m.index ?? 0;
    const open = idx + m[0].length - 1;
    let d = 0;
    let close = masked.length - 1;
    for (let k = open; k < masked.length; k++) {
      if (masked[k] === "(") d++;
      else if (masked[k] === ")" && --d === 0) {
        close = k;
        break;
      }
    }
    if (/^\s*over\b/i.test(masked.slice(close + 1))) continue; // window function, not a GROUP BY aggregate
    const inner = masked.slice(open + 1, close);
    const args = columns.filter((c) => c.index > open && c.index < close);
    aggregates.push({
      fn: m[1].toUpperCase(),
      distinct: /^\s*distinct\b/i.test(inner),
      raw: sql.slice(idx, close + 1),
      args,
      star: /^\s*\*\s*$/.test(inner),
      index: idx,
    });
  }

  const whereM = findTopLevel(masked, depth, /\bwhere\b/i);
  let where: Clause | null = null;
  if (whereM) {
    const a = whereM.index ?? 0;
    const endM = findTopLevel(masked, depth, /\b(?:group\s+by|order\s+by|limit|having|union|qualify|window)\b|;/i, a + 5);
    const b = endM ? endM.index ?? masked.length : masked.length;
    where = { text: masked.slice(a, b), quote: quoteOf(a, b), start: a, end: b };
  }

  // Every WHERE clause, at any depth; each ends at the next clause keyword or
  // the paren that closes its own level.
  const whereParts: string[] = [];
  for (const m of masked.matchAll(/\bwhere\b/gi)) {
    const w = m.index ?? 0;
    const d0 = depth[w] ?? 0;
    const stop = /\b(?:group\s+by|order\s+by|limit|having|union|qualify|window)\b|;|\)/gi;
    stop.lastIndex = w + 5;
    let end = masked.length;
    let sm: RegExpExecArray | null;
    while ((sm = stop.exec(masked))) {
      if ((depth[sm.index] ?? 0) === d0) {
        end = sm.index;
        break;
      }
    }
    const text = masked.slice(w, end);
    whereParts.push(text);
    // Implicit joins: "FROM a, b WHERE a.k = b.k"
    for (const pm of text.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) {
      const base = w + (pm.index ?? 0);
      const l = resolve(pm[1], pm[2], base, `${pm[1]}.${pm[2]}`);
      const r = resolve(pm[3], pm[4], base + pm[0].indexOf(pm[3], pm[1].length + pm[2].length + 1), `${pm[3]}.${pm[4]}`);
      if (l && r && byAlias.get(pm[1].toLowerCase()) !== byAlias.get(pm[3].toLowerCase()))
        joins.push({ quote: sql.slice(base, base + pm[0].length), start: base, pairs: [{ left: l, right: r }] });
    }
  }

  return {
    tables: tablesOut,
    columns,
    joins,
    aggregates,
    where,
    whereText: whereParts.join("\n"),
    select,
    selectItems,
    hasGroupBy: !!findTopLevel(masked, depth, /\bgroup\s+by\b/i),
    ctes,
  };
}
