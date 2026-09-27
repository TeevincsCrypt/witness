import type { Fixture, MemoryInput, QueryInput } from "./types";
import memoryHide from "../fixtures/memory-hide.json";
import memoryClean from "../fixtures/memory-clean.json";
import sqlBad from "../fixtures/sql-bad.json";
import sqlOk from "../fixtures/sql-ok.json";

export const MEMORY_FIXTURES = [memoryHide, memoryClean] as unknown as Fixture<MemoryInput>[];
export const QUERY_FIXTURES = [sqlBad, sqlOk] as unknown as Fixture<QueryInput>[];
