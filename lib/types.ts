// Shared WITNESS types. Both modules emit the same Receipt object.

export type Severity = "PASS" | "HIDE" | "INVENT" | "OVERRIDE" | "SILENT_FAIL";

/** fail = gates the verdict; warn = advisory, raises risk; info = explanatory note only. */
export type Level = "fail" | "warn" | "info";

export type EvidenceSource =
  | "compaction"
  | "tool"
  | "reply"
  | "sql"
  | "schema"
  | "question";

export type Evidence = {
  quote: string;
  source: EvidenceSource;
};

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: Evidence[];
  suggestion?: string;
  level?: Level; // defaults to "fail"
  origin?: "rule" | "llm";
  rule?: string; // which deterministic check produced it
  headline?: string; // short clause used to compose the one-sentence summary
};

export type Check = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
};

export type ReceiptMeta = {
  receiptNo: string;
  createdAt: string;
  auditor: string;
  llm: "off" | "ok" | "error";
  llmModel?: string;
  llmNote?: string;
};

export type Receipt = {
  module: "memory" | "query";
  score: number; // 0–1 risk
  verdict: "PASS" | "FAIL";
  findings: Finding[];
  summary: string; // one sentence for judges
  checks?: Check[];
  meta?: ReceiptMeta;
};

export type AgentStep = {
  i: number;
  role: "user" | "assistant" | "tool";
  name?: string; // tool name
  content: string;
};

export type MemoryInput = {
  steps: AgentStep[];
  compactionSummary: string;
  nextUserVisibleReply?: string;
};

export type Column = { name: string; type: string };

export type TableCard = {
  name: string;
  description: string;
  grain: string;
  status: "canonical" | "deprecated" | "unknown";
  columns: Column[];
  sampleRows?: Record<string, unknown>[];
};

export type QueryInput = {
  tables: TableCard[];
  sql: string;
  question?: string;
};

export type Fixture<T> = {
  id: "A" | "B" | "C" | "D";
  module: "memory" | "query";
  label: string;
  description: string;
  expected: "PASS" | "FAIL";
  input: T;
};

/** Minimal OpenAI-compatible chat call: (system, user) -> raw assistant text. */
export type LlmCall = (system: string, user: string) => Promise<string>;

export type AuditOptions = {
  llm?: LlmCall | null;
  llmModel?: string;
};
