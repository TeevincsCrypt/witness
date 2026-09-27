"use client";

import type { Check, Finding, Receipt as ReceiptT } from "@/lib/types";

const SOURCE_LABEL: Record<string, string> = {
  compaction: "hidden memory note",
  tool: "tool output",
  reply: "user-visible reply",
  sql: "sql",
  schema: "schema",
  question: "question",
};

function Rule() {
  return <div className="my-3 border-t border-dashed border-ink/35" />;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 leading-5">
      <span className="text-ink/55">{k}</span>
      <span className="text-right break-all">{v}</span>
    </div>
  );
}

function SevTag({ f }: { f: Finding }) {
  const level = f.level ?? "fail";
  const cls =
    f.severity === "PASS"
      ? "bg-stamp-ok text-paper"
      : level === "fail"
        ? "bg-stamp-bad text-paper"
        : level === "warn"
          ? "bg-stamp-warn text-paper"
          : "bg-ink/15 text-ink";
  return (
    <span className={`shrink-0 px-1.5 py-px text-[10px] font-bold tracking-wider ${cls}`}>
      {f.severity}
      {level === "warn" ? " · WARN" : level === "info" ? " · NOTE" : ""}
    </span>
  );
}

function CheckMark({ c }: { c: Check }) {
  const map = {
    pass: ["✓ PASS", "text-stamp-ok"],
    fail: ["✗ FAIL", "text-stamp-bad font-bold"],
    warn: ["! WARN", "text-stamp-warn font-bold"],
    skip: ["– N/A", "text-ink/40"],
  } as const;
  const [label, cls] = map[c.status];
  return <span className={`shrink-0 ${cls}`}>{label}</span>;
}

function Barcode({ seed }: { seed: string }) {
  const bars: number[] = [];
  for (let i = 0; i < 44; i++) {
    const c = seed.charCodeAt(i % seed.length) ^ (i * 31);
    bars.push((c % 3) + 1);
  }
  return (
    <div className="flex h-9 items-stretch justify-center gap-[2px]" aria-hidden>
      {bars.map((w, i) => (
        <span key={i} className="bg-ink" style={{ width: w }} />
      ))}
    </div>
  );
}

function formatTime(iso?: string) {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

export function Receipt({
  receipt,
  activeId,
  onHover,
}: {
  receipt: ReceiptT;
  activeId?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const fail = receipt.verdict === "FAIL";
  const advisory = !fail && receipt.findings.some((f) => (f.level ?? "fail") === "warn");
  const stampCls = fail ? "text-stamp-bad" : advisory ? "text-stamp-warn" : "text-stamp-ok";
  const barCls = receipt.score >= 0.7 ? "bg-stamp-bad" : receipt.score >= 0.3 ? "bg-stamp-warn" : "bg-stamp-ok";
  const m = receipt.meta;

  return (
    <div className="mx-auto w-full max-w-[460px] drop-shadow-[0_18px_30px_rgba(0,0,0,0.55)]">
      <div className="paper-edge-top" />
      <div className="bg-paper px-5 pb-5 pt-3 font-mono text-[12px] text-ink">
        <div className="text-center">
          <div className="text-[15px] font-bold tracking-[0.45em]">WITNESS</div>
          <div className="mt-0.5 text-[10px] tracking-[0.3em] text-ink/60">AUDIT RECEIPT</div>
        </div>
        <Rule />
        <Row k="RECEIPT" v={m?.receiptNo ?? "—"} />
        <Row k="ISSUED" v={formatTime(m?.createdAt)} />
        <Row k="MODULE" v={receipt.module === "memory" ? "MEMORY WITNESS" : "QUERY WITNESS"} />
        <Row k="AUDITOR" v={m?.auditor ?? "rules v1"} />
        <Rule />

        <div className="flex items-center justify-between py-1">
          <div className={`stamp border-[3px] border-current px-4 py-1 text-3xl font-black tracking-[0.3em] ${stampCls}`}>
            {receipt.verdict}
          </div>
          <div className="text-right">
            <div className="text-[10px] tracking-[0.25em] text-ink/55">RISK</div>
            <div className="text-3xl font-bold tabular-nums">{receipt.score.toFixed(2)}</div>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full bg-ink/10">
          <div className={`h-full ${barCls}`} style={{ width: `${Math.max(2, receipt.score * 100)}%` }} />
        </div>
        <p className="mt-3 text-[12.5px] leading-[1.45]">{receipt.summary}</p>
        <Rule />

        <div className="mb-2 flex justify-between text-[10px] tracking-[0.25em] text-ink/60">
          <span>FINDINGS</span>
          <span>{receipt.findings.length.toString().padStart(2, "0")}</span>
        </div>
        {receipt.findings.length === 0 && <div className="py-2 text-center tracking-[0.2em] text-stamp-ok">NO FINDINGS</div>}
        <ol className="space-y-1">
          {receipt.findings.map((f, idx) => (
            <li
              key={f.id}
              id={`finding-${f.id}`}
              onMouseEnter={() => onHover?.(f.id)}
              onMouseLeave={() => onHover?.(null)}
              className={`-mx-2 px-2 py-2 transition-colors ${activeId === f.id ? "bg-ink/[0.07]" : ""}`}
            >
              <div className="flex items-start gap-2">
                <span className="w-5 shrink-0 text-ink/45">{String(idx + 1).padStart(2, "0")}</span>
                <SevTag f={f} />
                {f.origin === "llm" && (
                  <span className="shrink-0 border border-ink/40 px-1 text-[10px] tracking-wider text-ink/60">LLM</span>
                )}
              </div>
              <div className="mt-1 pl-7 font-bold leading-snug">{f.title}</div>
              {f.detail && <p className="mt-1 pl-7 leading-[1.45] text-ink/75">{f.detail}</p>}
              {f.evidence.length > 0 && (
                <ul className="mt-1.5 space-y-1 pl-7">
                  {f.evidence.map((e, k) => (
                    <li key={k} className="border-l-2 border-stamp-bad/70 pl-2 leading-snug">
                      <span className="break-words">“{e.quote}”</span>{" "}
                      <span className="whitespace-nowrap text-[10.5px] text-ink/50">— {SOURCE_LABEL[e.source] ?? e.source}</span>
                    </li>
                  ))}
                </ul>
              )}
              {f.suggestion && <div className="mt-1.5 pl-7 leading-snug text-ink/80">→ {f.suggestion}</div>}
            </li>
          ))}
        </ol>

        {receipt.checks && receipt.checks.length > 0 && (
          <>
            <Rule />
            <div className="mb-1.5 text-[10px] tracking-[0.25em] text-ink/60">CHECKS RUN</div>
            <ul className="space-y-0.5">
              {receipt.checks.map((c) => (
                <li key={c.id} className="flex justify-between gap-3 leading-5">
                  <span className={c.status === "skip" ? "text-ink/40" : ""}>{c.label}</span>
                  <CheckMark c={c} />
                </li>
              ))}
            </ul>
          </>
        )}
        <Rule />
        {m?.llmNote && <p className="mb-3 text-[10.5px] leading-snug text-ink/60">{m.llmNote}</p>}
        <Barcode seed={m?.receiptNo ?? "W-00000000"} />
        <div className="mt-2 text-center text-[10px] tracking-[0.2em] text-ink/70">CATCHES FAILURES THAT LOOK CORRECT.</div>
      </div>
      <div className="paper-edge-bottom" />
    </div>
  );
}

export function EmptyReceipt() {
  return (
    <div className="mx-auto w-full max-w-[460px] opacity-60">
      <div className="paper-edge-top" />
      <div className="bg-paper px-5 py-6 font-mono text-[12px] text-ink">
        <div className="text-center">
          <div className="text-[15px] font-bold tracking-[0.45em]">WITNESS</div>
          <div className="mt-0.5 text-[10px] tracking-[0.3em] text-ink/60">AUDIT RECEIPT</div>
        </div>
        <Rule />
        <div className="space-y-2 py-4 text-center leading-relaxed text-ink/70">
          <div className="tracking-[0.25em]">AWAITING INPUT</div>
          <div className="text-[11px]">Load a fixture, or paste your own input and press Run WITNESS.</div>
        </div>
        <Rule />
        {[0, 1, 2].map((i) => (
          <div key={i} className="my-2 h-2 bg-ink/10" style={{ width: `${90 - i * 18}%` }} />
        ))}
      </div>
      <div className="paper-edge-bottom" />
    </div>
  );
}
