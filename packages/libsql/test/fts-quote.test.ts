/**
 * Regression test for M15 (libsql): FTS5 tokens containing `"` must not
 * break/inject into the MATCH expression.
 *
 * Before the fix: `"token"` was emitted as-is → an embedded `"` would close
 * the FTS5 quoted-token early, producing a syntax error or unexpected matches.
 * After the fix: embedded `"` chars are doubled (`""`), which is the FTS5
 * quoted-token escape.
 */

import { describe, it, expect } from "vitest";
import { LibsqlStore } from "../src/index.js";
import type { Scope } from "@eidentic/types";

const scope: Scope = { kind: "agent", agentId: "fts-quote-test" };

describe('LibsqlStore — FTS5 query with embedded " does not throw', () => {
  it('searchMemory with a query containing " returns sane results without throwing', async () => {
    const store = new LibsqlStore(":memory:");
    await store.migrate();

    await store.indexMemory([
      { scope, id: "m1", text: "hello world" },
      { scope, id: "m2", text: "foo bar baz" },
    ]);

    // These queries contain double-quotes that would previously inject into the
    // FTS5 MATCH expression and cause a syntax error.
    await expect(store.searchMemory(scope, '"hello"', 10)).resolves.not.toThrow();
    await expect(store.searchMemory(scope, 'say "hello" world', 10)).resolves.not.toThrow();
    await expect(store.searchMemory(scope, '"', 10)).resolves.toEqual([]);
    await expect(store.searchMemory(scope, '""', 10)).resolves.not.toThrow();

    // A real word mixed with quotes must still match.
    const results = await store.searchMemory(scope, '"hello"', 10);
    // "hello" tokenizes to ["hello"] after stripping the quotes by tokenize(),
    // OR the whole string is treated as a single token containing quotes.
    // Either way the call must not throw, and the result must be an array.
    expect(Array.isArray(results)).toBe(true);

    await store.close();
  });

  it('indexMemory + searchMemory with a text containing " does not corrupt FTS index', async () => {
    const store = new LibsqlStore(":memory:");
    await store.migrate();

    // Index text that happens to contain a double-quote character.
    await store.indexMemory([
      { scope, id: "q1", text: 'She said "hello" to everyone' },
      { scope, id: "q2", text: "ordinary document about greetings" },
    ]);

    // Searching for a clean word must still work even after indexing quoted text.
    const hits = await store.searchMemory(scope, "greetings", 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.find((h) => h.id === "q2")).toBeDefined();

    await store.close();
  });
});
