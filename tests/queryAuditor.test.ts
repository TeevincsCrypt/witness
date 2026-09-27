import { describe, expect, it } from "vitest";
import { analyzeSql, auditQuery, auditQueryRules, entityOf } from "../lib/queryAuditor";
import { validateQueryInput } from "../lib/validate";
import type { QueryInput } from "../lib/types";
import C from "../fixtures/sql-bad.json";
import D from "../fixtures/sql-ok.json";

const fixtureC = C.input as QueryInput;
const fixtureD = D.input as QueryInput;

describe("Query Witness rules", () => {
  it("Fixture C fails: stale twin + grain clash", async () => {
    const r = await auditQuery(fixtureC);
    expect(r.verdict).toBe("FAIL");
    const rules = new Set(r.findings.map((f) => f.rule));
    expect(rules.has("stale")).toBe(true);
    expect(rules.has("grain")).toBe(true);
    expect(rules.has("intent")).toBe(true);
    const stale = r.findings.find((f) => f.rule === "stale")!;
    expect(stale.severity).toBe("SILENT_FAIL");
    expect(stale.title).toContain("customers_crm");
    const grain = r.findings.find((f) => f.rule === "grain")!;
    expect(grain.title).toMatch(/account.*line_item/);
    expect(grain.detail).toContain("2.0");
    expect(grain.evidence.map((e) => e.quote)).toContain("JOIN orders o ON c.customer_id = o.customer_id");
  });

  it("Fixture D passes", async () => {
    const r = await auditQuery(fixtureD);
    expect(r.verdict).toBe("PASS");
    expect(r.findings).toEqual([]);
    expect(r.score).toBeLessThan(0.3);
  });

  it("flags unknown tables and columns as INVENT", () => {
    const f = auditQueryRules({
      ...fixtureD,
      sql: "SELECT o.amt FROM orders o JOIN customer_master m ON m.customer_id = o.customer_id",
    });
    expect(f.find((x) => x.rule === "tables")?.title).toBe("Unknown table: customer_master");
    const col = f.find((x) => x.rule === "columns")!;
    expect(col.severity).toBe("INVENT");
    expect(col.suggestion).toBe("Did you mean o.amount?");
  });

  it("warns on unbounded fact aggregates", () => {
    const f = auditQueryRules({
      ...fixtureD,
      sql: "SELECT c.segment, SUM(o.amount) FROM customers_crm c JOIN orders o ON c.customer_id = o.customer_id GROUP BY c.segment",
    });
    expect(f.map((x) => [x.rule, x.level])).toEqual([["bounded", "warn"]]);
  });

  it("ignores FROM inside EXTRACT and comments / strings", () => {
    const a = analyzeSql(
      "-- from fake_table\nSELECT EXTRACT(year FROM o.order_date), 'join nope' FROM orders o",
      fixtureD.tables,
    );
    expect(a.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("derives entities for twin detection", () => {
    expect(entityOf("customers_v1")).toBe("customer");
    expect(entityOf("customers_crm")).toBe("customer");
    expect(entityOf("analytics.dim_customers")).toBe("customer");
  });
});

describe("Query LLM layer", () => {
  it("adds the 2x explanation to the summary and a note finding", async () => {
    const llm = async () =>
      JSON.stringify({
        twoXCause: "customers_v1 has two accounts per customer, so every line item is summed twice.",
        shouldUseTable: "customers_crm",
        findings: [],
      });
    const r = await auditQuery(fixtureC, { llm, llmModel: "mock" });
    expect(r.summary).toContain("LLM: customers_v1 has two accounts");
    const note = r.findings.find((f) => f.id === "q-llm-2x")!;
    expect(note.level).toBe("info");
    expect(note.detail).toContain("Should use: customers_crm");
  });

  it("keeps a clean query PASS even when the model adds a note", async () => {
    const llm = async () => JSON.stringify({ twoXCause: "Duplicate line items would double it.", shouldUseTable: null, findings: [] });
    const r = await auditQuery(fixtureD, { llm });
    expect(r.verdict).toBe("PASS");
  });
});

describe("validation", () => {
  it("rejects empty SQL / schema with a message", () => {
    expect(validateQueryInput({ tables: fixtureD.tables, sql: "" }).ok).toBe(false);
    expect(validateQueryInput({ tables: [], sql: "select 1" }).ok).toBe(false);
    expect(validateQueryInput(undefined).ok).toBe(false);
  });
});
