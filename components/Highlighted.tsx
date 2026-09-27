"use client";

import { segment, type Mark } from "@/lib/highlight";

export type PickHandler = (findingId: string) => void;

export function Highlighted({
  text,
  marks,
  activeId,
  onPick,
}: {
  text: string;
  marks: Mark[];
  activeId?: string | null;
  onPick?: PickHandler;
}) {
  const segs = segment(text, marks);
  return (
    <>
      {segs.map((s, i) => {
        if (s.marks.length === 0) return <span key={i}>{s.text}</span>;
        const level = s.marks.some((m) => m.level === "fail")
          ? "fail"
          : s.marks.some((m) => m.level === "warn")
            ? "warn"
            : "info";
        const active = !!activeId && s.marks.some((m) => m.findingId === activeId);
        const title = Array.from(new Set(s.marks.map((m) => m.title))).join("\n");
        return (
          <mark
            key={i}
            className={`hl hl-${level}${active ? " hl-active" : ""}`}
            title={title}
            onClick={() => onPick?.(s.marks[0].findingId)}
          >
            {s.text}
          </mark>
        );
      })}
    </>
  );
}
