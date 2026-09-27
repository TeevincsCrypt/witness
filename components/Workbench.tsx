"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Fixture, MemoryInput, QueryInput, Receipt as ReceiptT } from "@/lib/types";
import { MEMORY_FIXTURES, QUERY_FIXTURES } from "@/lib/fixtures";
import { validateMemoryInput, validateQueryInput, type Validated } from "@/lib/validate";
import { auditMemory } from "@/lib/memoryAuditor";
import { auditQuery } from "@/lib/queryAuditor";
import { EmptyReceipt, Receipt } from "./Receipt";
import { TraceView } from "./TraceView";
import { SqlView } from "./SqlView";

type Mod = "memory" | "query";
type View = "input" | "evidence";
type Result =
  | { mod: "memory"; receipt: ReceiptT; input: MemoryInput }
  | { mod: "query"; receipt: ReceiptT; input: QueryInput };

const ALL_FIXTURES: (Fixture<MemoryInput> | Fixture<QueryInput>)[] = [...MEMORY_FIXTURES, ...QUERY_FIXTURES];

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-dim">
        <span>{label}</span>
        {hint && <span className="normal-case tracking-normal text-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const areaCls =
  "block w-full resize-y rounded border border-line bg-panel-2 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg placeholder:text-faint focus:border-line-2 focus:outline-none";

export default function Workbench() {
  const [tab, setTab] = useState<Mod>("memory");
  const [view, setView] = useState<Record<Mod, View>>({ memory: "input", query: "input" });

  const [trace, setTrace] = useState("");
  const [summary, setSummary] = useState("");
  const [reply, setReply] = useState("");
  const [schema, setSchema] = useState("");
  const [sql, setSql] = useState("");
  const [question, setQuestion] = useState("");

  const [results, setResults] = useState<Partial<Record<Mod, Result>>>({});
  const [errors, setErrors] = useState<Partial<Record<Mod, string>>>({});
  const [running, setRunning] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [llmInfo, setLlmInfo] = useState<{ llm: boolean; model: string | null } | null>(null);
  const [useLlm, setUseLlm] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/audit")
      .then((r) => r.json())
      .then((d) => setLlmInfo({ llm: !!d.llm, model: d.model ?? null }))
      .catch(() => setLlmInfo({ llm: false, model: null }));
  }, []);

  const setError = (mod: Mod, msg?: string) => setErrors((e) => ({ ...e, [mod]: msg }));

  const parseMemory = useCallback((): Validated<MemoryInput> => {
    let steps: unknown = [];
    let s = summary;
    let r = reply;
    if (trace.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trace);
      } catch (e) {
        return { ok: false, error: `Trace is not valid JSON: ${e instanceof Error ? e.message : "parse error"}` };
      }
      if (Array.isArray(parsed)) steps = parsed;
      else if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        const inner = (o.input && typeof o.input === "object" ? o.input : o) as Record<string, unknown>;
        steps = inner.steps ?? [];
        if (!s.trim() && typeof inner.compactionSummary === "string") s = inner.compactionSummary;
        if (!r.trim() && typeof inner.nextUserVisibleReply === "string") r = inner.nextUserVisibleReply;
      } else return { ok: false, error: "Trace must be a JSON array of steps." };
    }
    return validateMemoryInput({ steps, compactionSummary: s, nextUserVisibleReply: r });
  }, [trace, summary, reply]);

  const parseQuery = useCallback((): Validated<QueryInput> => {
    if (!schema.trim()) return { ok: false, error: "Paste the schema: a JSON array of table cards." };
    let tables: unknown;
    try {
      tables = JSON.parse(schema);
    } catch (e) {
      return { ok: false, error: `Schema is not valid JSON: ${e instanceof Error ? e.message : "parse error"}` };
    }
    if (tables && typeof tables === "object" && !Array.isArray(tables)) {
      const o = tables as Record<string, unknown>;
      const inner = (o.input && typeof o.input === "object" ? o.input : o) as Record<string, unknown>;
      tables = inner.tables;
    }
    return validateQueryInput({ tables, sql, question });
  }, [schema, sql, question]);

  const run = useCallback(
    async (mod: Mod, preset?: MemoryInput | QueryInput) => {
      const v: Validated<MemoryInput | QueryInput> = preset
        ? mod === "memory"
          ? validateMemoryInput(preset)
          : validateQueryInput(preset)
        : mod === "memory"
          ? parseMemory()
          : parseQuery();
      if (!v.ok) {
        setError(mod, v.error);
        setView((x) => ({ ...x, [mod]: "input" }));
        return;
      }
      setError(mod, undefined);
      setRunning(true);
      setActiveId(null);
      let receipt: ReceiptT;
      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ module: mod, input: v.value, llm: useLlm }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(mod, data?.error ?? `Audit failed (HTTP ${res.status}).`);
          setRunning(false);
          return;
        }
        receipt = data as ReceiptT;
      } catch {
        // Offline / API down: the rules are pure TypeScript, so run them here.
        receipt =
          mod === "memory" ? await auditMemory(v.value as MemoryInput) : await auditQuery(v.value as QueryInput);
        if (receipt.meta) receipt.meta.llmNote = "API unreachable — rules ran in the browser.";
      }
      setResults((r) => ({ ...r, [mod]: { mod, receipt, input: v.value } as Result }));
      setView((x) => ({ ...x, [mod]: "evidence" }));
      setRunning(false);
    },
    [parseMemory, parseQuery, useLlm],
  );

  function fillMemory(input: MemoryInput) {
    setTrace(pretty(input.steps));
    setSummary(input.compactionSummary);
    setReply(input.nextUserVisibleReply ?? "");
  }
  function fillQuery(input: QueryInput) {
    setSchema(pretty(input.tables));
    setSql(input.sql);
    setQuestion(input.question ?? "");
  }

  function loadFixture(f: Fixture<MemoryInput> | Fixture<QueryInput>) {
    setTab(f.module);
    if (f.module === "memory") fillMemory(f.input as MemoryInput);
    else fillQuery(f.input as QueryInput);
    void run(f.module, f.input);
  }

  function onUpload(file: File) {
    file.text().then((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        setError(tab, `${file.name} is not valid JSON.`);
        return;
      }
      const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const inner = (o.input && typeof o.input === "object" ? o.input : o) as Record<string, unknown>;
      const mod: Mod = "sql" in inner || "tables" in inner ? "query" : "steps" in inner || "compactionSummary" in inner ? "memory" : tab;
      setTab(mod);
      setView((x) => ({ ...x, [mod]: "input" }));
      setError(mod, undefined);
      if (Array.isArray(raw)) {
        if (mod === "memory") setTrace(pretty(raw));
        else setSchema(pretty(raw));
      } else if (mod === "memory") {
        setTrace(pretty(inner.steps ?? []));
        setSummary(String(inner.compactionSummary ?? ""));
        setReply(String(inner.nextUserVisibleReply ?? ""));
      } else {
        setSchema(pretty(inner.tables ?? []));
        setSql(String(inner.sql ?? ""));
        setQuestion(String(inner.question ?? ""));
      }
    });
  }

  function clearTab() {
    if (tab === "memory") {
      setTrace("");
      setSummary("");
      setReply("");
    } else {
      setSchema("");
      setSql("");
      setQuestion("");
    }
    setResults((r) => ({ ...r, [tab]: undefined }));
    setError(tab, undefined);
    setView((x) => ({ ...x, [tab]: "input" }));
  }

  const pick = (id: string) => {
    setActiveId(id);
    document.getElementById(`finding-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void run(tab);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, tab]);

  const result = results[tab];
  const currentView = view[tab];
  const error = errors[tab];
  const llmOn = !!llmInfo?.llm && useLlm;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex h-12 w-full max-w-[1680px] items-center gap-4 px-4">
          <div className="font-mono text-[15px] font-bold tracking-[0.4em] text-fg">WITNESS</div>
          <div className="hidden text-[12px] text-dim sm:block">Catches failures that look correct.</div>
          <div className="ml-auto flex items-center gap-3 font-mono text-[11px]">
            <label
              className={`flex items-center gap-1.5 ${llmInfo?.llm ? "cursor-pointer text-dim" : "cursor-not-allowed text-faint"}`}
              title={llmInfo?.llm ? "Add a grounded LLM pass on top of the rules" : "Set OPENAI_API_KEY to enable the LLM pass"}
            >
              <input
                type="checkbox"
                className="accent-[#d8dce2]"
                disabled={!llmInfo?.llm}
                checked={llmOn}
                onChange={(e) => setUseLlm(e.target.checked)}
              />
              LLM pass
            </label>
            <span className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-1 uppercase tracking-wider">
              <span className={`h-1.5 w-1.5 rounded-full ${llmOn ? "bg-ok" : "bg-dim"}`} />
              <span className={llmOn ? "text-fg" : "text-dim"}>
                {llmInfo === null ? "…" : llmOn ? `rules + ${llmInfo.model}` : "rules only"}
              </span>
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1680px] flex-1 px-4 py-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex rounded border border-line bg-panel p-0.5" role="tablist">
            {(["memory", "query"] as Mod[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={tab === m}
                onClick={() => {
                  setTab(m);
                  setActiveId(null);
                }}
                className={`rounded-sm px-4 py-1.5 font-mono text-[12px] uppercase tracking-[0.18em] transition-colors ${
                  tab === m ? "bg-fg text-bg" : "text-dim hover:text-fg"
                }`}
              >
                {m === "memory" ? "Memory" : "Query"}
                {results[m] && (
                  <span
                    className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                      results[m]!.receipt.verdict === "FAIL" ? "bg-bad" : "bg-ok"
                    }`}
                  />
                )}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-faint">Fixtures</span>
            {ALL_FIXTURES.map((f) => (
              <button
                key={f.id}
                onClick={() => loadFixture(f)}
                title={f.description}
                className="group flex items-center gap-2 rounded border border-line bg-panel px-2.5 py-1.5 text-left transition-colors hover:border-line-2 hover:bg-panel-2"
              >
                <span className="font-mono text-[12px] font-bold text-fg">{f.id}</span>
                <span className="text-[12px] text-dim group-hover:text-fg">{f.label.split("·")[1]?.trim() ?? f.label}</span>
                <span className={`font-mono text-[9.5px] tracking-wider ${f.expected === "FAIL" ? "text-bad" : "text-ok"}`}>
                  {f.module === "memory" ? "MEM" : "SQL"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,460px)]">
          {/* Left: source */}
          <section className="min-w-0 rounded border border-line bg-panel">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <div className="flex rounded-sm border border-line p-0.5">
                {(["input", "evidence"] as View[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView((x) => ({ ...x, [tab]: v }))}
                    className={`rounded-sm px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] ${
                      currentView === v ? "bg-panel-2 text-fg" : "text-faint hover:text-dim"
                    }`}
                  >
                    {v === "input" ? "Input" : "Evidence"}
                  </button>
                ))}
              </div>
              <span className="hidden font-mono text-[11px] text-faint md:inline">
                {tab === "memory" ? "agent trace + hidden compaction note" : "schema cards + generated SQL"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(f);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="rounded-sm border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-dim hover:border-line-2 hover:text-fg"
                >
                  Upload JSON
                </button>
                <button
                  onClick={clearTab}
                  className="rounded-sm border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-dim hover:border-line-2 hover:text-fg"
                >
                  Clear
                </button>
                <button
                  onClick={() => void run(tab)}
                  disabled={running}
                  className="rounded-sm bg-fg px-4 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                  title="Ctrl/⌘ + Enter"
                >
                  {running ? "Auditing…" : "Run WITNESS"}
                </button>
              </div>
            </div>

            <div className="p-4">
              {error && (
                <div
                  role="alert"
                  className="mb-4 rounded border border-bad/50 bg-bad/[0.07] px-3 py-2 font-mono text-[12px] text-bad"
                >
                  {error}
                </div>
              )}

              {currentView === "input" && tab === "memory" && (
                <div className="space-y-4">
                  <Field label="Trace" hint="JSON array of steps: { role, name?, content }">
                    <textarea
                      className={`${areaCls} h-56`}
                      spellCheck={false}
                      value={trace}
                      onChange={(e) => setTrace(e.target.value)}
                      placeholder={'[\n  { "role": "user", "content": "…" },\n  { "role": "tool", "name": "get_revenue", "content": "{…}" }\n]'}
                    />
                  </Field>
                  <Field label="Compaction summary" hint="the next-context note the agent wrote for itself — the user never sees it">
                    <textarea
                      className={`${areaCls} h-28`}
                      spellCheck={false}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      placeholder="Paste the memory / compaction summary here."
                    />
                  </Field>
                  <Field label="Next user-visible reply" hint="optional">
                    <textarea
                      className={`${areaCls} h-16`}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="What the user actually saw next."
                    />
                  </Field>
                </div>
              )}

              {currentView === "input" && tab === "query" && (
                <div className="space-y-4">
                  <Field label="Question" hint="optional — the business question the SQL answers">
                    <input
                      className={`${areaCls} h-9`}
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="Current West region revenue by segment."
                    />
                  </Field>
                  <Field label="SQL">
                    <textarea
                      className={`${areaCls} h-40`}
                      spellCheck={false}
                      value={sql}
                      onChange={(e) => setSql(e.target.value)}
                      placeholder="SELECT …"
                    />
                  </Field>
                  <Field label="Schema" hint="JSON array of table cards: { name, status, grain, description, columns }">
                    <textarea
                      className={`${areaCls} h-64`}
                      spellCheck={false}
                      value={schema}
                      onChange={(e) => setSchema(e.target.value)}
                      placeholder={'[\n  { "name": "orders", "status": "canonical", "grain": "line_item", "description": "…", "columns": [{ "name": "amount", "type": "decimal" }] }\n]'}
                    />
                  </Field>
                </div>
              )}

              {currentView === "evidence" &&
                (result ? (
                  result.mod === "memory" ? (
                    <TraceView input={result.input} findings={result.receipt.findings} activeId={activeId} onPick={pick} />
                  ) : (
                    <SqlView input={result.input} findings={result.receipt.findings} activeId={activeId} onPick={pick} />
                  )
                ) : (
                  <div className="rounded border border-dashed border-line p-8 text-center text-sm text-dim">
                    Run WITNESS or load a fixture to see highlighted evidence.
                  </div>
                ))}
            </div>
          </section>

          {/* Right: receipt */}
          <aside className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-4">
            {result ? (
              <Receipt receipt={result.receipt} activeId={activeId} onHover={setActiveId} />
            ) : (
              <EmptyReceipt />
            )}
          </aside>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center justify-between gap-2 px-4 py-3 font-mono text-[11px] text-faint">
          <span className="text-dim">Catches failures that look correct.</span>
          <span>Sidecar auditor — it reads the agent&apos;s output; it does not replace the agent.</span>
        </div>
      </footer>
    </div>
  );
}
