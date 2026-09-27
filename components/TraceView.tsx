"use client";

import type { Finding, MemoryInput } from "@/lib/types";
import { marksFor } from "@/lib/highlight";
import { Highlighted, type PickHandler } from "./Highlighted";

const ROLE_CLS: Record<string, string> = {
  user: "text-sky-300",
  assistant: "text-violet-300",
  tool: "text-amber-300",
};

function PanelLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-dim">
      <span>{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

/** Left: agent steps. Right: the hidden compaction note vs. what the user saw. */
export function TraceView({
  input,
  findings,
  activeId,
  onPick,
}: {
  input: MemoryInput;
  findings: Finding[];
  activeId?: string | null;
  onPick?: PickHandler;
}) {
  const toolMarks = marksFor(findings, ["tool"]);
  const summaryMarks = marksFor(findings, ["compaction"]);
  const replyMarks = marksFor(findings, ["reply"]);
  const summaryFlagged = summaryMarks.some((m) => m.level === "fail");
  const replyFlagged = replyMarks.some((m) => m.level === "fail");

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="min-w-0">
        <PanelLabel right={`${input.steps.length} steps`}>Agent trace</PanelLabel>
        {input.steps.length === 0 && (
          <div className="rounded border border-dashed border-line p-4 text-sm text-dim">No steps provided.</div>
        )}
        <ol className="space-y-2">
          {input.steps.map((s, k) => {
            const marks = s.role === "tool" ? toolMarks : [];
            const hit = marks.some((m) => s.content.toLowerCase().includes(m.quote.toLowerCase().replace(/…$/, "")));
            return (
              <li
                key={k}
                className={`overflow-hidden rounded border bg-panel-2 ${hit ? "border-bad/50" : "border-line"}`}
              >
                <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-wider text-dim">
                  <span className="text-faint">#{s.i}</span>
                  <span className={ROLE_CLS[s.role]}>{s.role}</span>
                  {s.name && <span className="normal-case text-fg">{s.name}</span>}
                  {hit && <span className="ml-auto text-bad">evidence</span>}
                </div>
                <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg">
                  <Highlighted text={s.content} marks={marks} activeId={activeId} onPick={onPick} />
                </pre>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="min-w-0 space-y-4">
        <div>
          <PanelLabel
            right={
              <span className="whitespace-nowrap rounded-sm border border-bad/50 px-1.5 py-px text-bad">hidden from user</span>
            }
          >
            Compaction summary · next-context note
          </PanelLabel>
          <div
            className={`rounded border p-3 font-mono text-[13px] leading-relaxed ${
              summaryFlagged ? "border-bad/60 bg-bad/[0.04]" : "border-line bg-panel-2"
            }`}
          >
            <p className="whitespace-pre-wrap break-words">
              <Highlighted text={input.compactionSummary} marks={summaryMarks} activeId={activeId} onPick={onPick} />
            </p>
          </div>
        </div>

        <div>
          <PanelLabel
            right={<span className="whitespace-nowrap rounded-sm border border-line-2 px-1.5 py-px text-fg">what the user saw</span>}
          >
            Next user-visible reply
          </PanelLabel>
          {input.nextUserVisibleReply ? (
            <div
              className={`rounded border p-3 text-[14px] leading-relaxed ${
                replyFlagged ? "border-bad/40 bg-panel-2" : "border-line bg-panel-2"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">
                <Highlighted text={input.nextUserVisibleReply} marks={replyMarks} activeId={activeId} onPick={onPick} />
              </p>
            </div>
          ) : (
            <div className="rounded border border-dashed border-line p-3 text-sm text-dim">Not provided.</div>
          )}
          {replyFlagged && summaryFlagged && (
            <p className="mt-2 font-mono text-[11px] leading-snug text-dim">
              The reply reads fine on its own. The problem is only visible in the note the user never sees.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
