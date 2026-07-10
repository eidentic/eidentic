import { describe, it, expect, vi } from "vitest";
import type { MemoryEvent, Scope } from "@eidentic/types";
import { ingestDocument as guardedIngestDocument } from "../src/ingest.js";
import type { IngestableMemory } from "../src/ingest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const agentScope: Scope = { kind: "agent", agentId: "test-agent" };
const ingestDocument: typeof guardedIngestDocument = (source, opts) => guardedIngestDocument(source, {
  unsafeAllowAnyPublicHost: opts.allowlist === undefined,
  allowInsecureHttp: true,
  ...opts,
});

/** A fake memory that captures all ingested events. */
function fakeMemory(): IngestableMemory & { events: MemoryEvent[] } {
  const events: MemoryEvent[] = [];
  return {
    events,
    async ingest(evts: MemoryEvent[]) {
      events.push(...evts);
    },
  };
}

/** A fake fetch that returns `body` with status `200`. */
function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// String source
// ---------------------------------------------------------------------------

describe("ingestDocument — string source", () => {
  it("ingests a short document as a single chunk", async () => {
    const mem = fakeMemory();
    const result = await ingestDocument("Hello world.", { memory: mem, scope: agentScope, docId: "test-doc" });
    expect(result.chunks).toBe(1);
    expect(mem.events).toHaveLength(1);
    expect(mem.events[0]!.id).toBe("test-doc:chunk:0");
    expect(mem.events[0]!.scope).toEqual(agentScope);
    expect(mem.events[0]!.text).toBe("Hello world.");
  });

  it("produces stable chunk ids: ${docId}:chunk:${i}", async () => {
    const mem = fakeMemory();
    const text = "word ".repeat(400); // ~2000 chars — multiple chunks
    await ingestDocument(text, {
      memory: mem,
      scope: agentScope,
      docId: "my-doc",
      chunk: { size: 500, overlap: 0 },
    });
    for (let i = 0; i < mem.events.length; i++) {
      expect(mem.events[i]!.id).toBe(`my-doc:chunk:${i}`);
    }
  });

  it("threads scope into every event", async () => {
    const mem = fakeMemory();
    const scope: Scope = { kind: "user", agentId: "agent-1", userId: "user-1" };
    await ingestDocument("Some text content.", { memory: mem, scope, docId: "d" });
    for (const e of mem.events) {
      expect(e.scope).toEqual(scope);
    }
  });

  it("reports correct chunk count", async () => {
    const mem = fakeMemory();
    const text = "word ".repeat(1000); // ~5000 chars
    const result = await ingestDocument(text, {
      memory: mem,
      scope: agentScope,
      docId: "big",
      chunk: { size: 500, overlap: 0 },
    });
    expect(result.chunks).toBe(mem.events.length);
    expect(result.chunks).toBeGreaterThan(1);
  });

  it("returns { chunks: 0 } and does not call ingest for empty string", async () => {
    const mem = fakeMemory();
    const ingestSpy = vi.spyOn(mem, "ingest");
    const result = await ingestDocument("   ", { memory: mem, scope: agentScope, docId: "empty" });
    expect(result.chunks).toBe(0);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("auto-generates docId from text hash when not provided", async () => {
    const mem = fakeMemory();
    await ingestDocument("Some content.", { memory: mem, scope: agentScope });
    expect(mem.events[0]!.id).toMatch(/^doc-[0-9a-f]+:chunk:0$/);
  });
});

// ---------------------------------------------------------------------------
// URL source
// ---------------------------------------------------------------------------

describe("ingestDocument — URL source", () => {
  it("denies an omitted host allowlist by default", async () => {
    const mem = fakeMemory();
    await expect(guardedIngestDocument({ url: "https://example.com/doc" }, {
      memory: mem,
      scope: agentScope,
      fetchImpl: fakeFetch("SHOULD NOT REACH"),
      resolveHosts: false,
    })).rejects.toThrow(/allowlist/i);
    expect(mem.events).toHaveLength(0);
  });

  it("fetches text from URL and ingests it", async () => {
    const mem = fakeMemory();
    const docText = "This is fetched document text.";
    const result = await ingestDocument(
      { url: "https://example.com/doc.txt" },
      {
        memory: mem,
        scope: agentScope,
        docId: "fetched-doc",
        fetchImpl: fakeFetch(docText),
      },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.text).toBe(docText);
    expect(mem.events[0]!.id).toBe("fetched-doc:chunk:0");
  });

  it("derives docId from URL slug when docId not provided", async () => {
    const mem = fakeMemory();
    await ingestDocument(
      { url: "https://example.com/my-article/content" },
      { memory: mem, scope: agentScope, fetchImpl: fakeFetch("text content") },
    );
    // Should generate a slug from the URL
    expect(mem.events[0]!.id).toMatch(/^example-com-my-article-content:chunk:0$/);
  });

  it("throws on non-2xx response", async () => {
    const mem = fakeMemory();
    await expect(
      ingestDocument(
        { url: "https://example.com/missing" },
        { memory: mem, scope: agentScope, fetchImpl: fakeFetch("not found", 404) },
      ),
    ).rejects.toThrow(/HTTP 404/);
    expect(mem.events).toHaveLength(0);
  });

  it("chunks a large fetched document and produces sequential ids", async () => {
    const mem = fakeMemory();
    const bigText = "word ".repeat(500); // ~2500 chars
    await ingestDocument(
      { url: "https://example.com/large.txt" },
      {
        memory: mem,
        scope: agentScope,
        docId: "large-doc",
        chunk: { size: 500, overlap: 0 },
        fetchImpl: fakeFetch(bigText),
      },
    );
    expect(mem.events.length).toBeGreaterThan(1);
    for (let i = 0; i < mem.events.length; i++) {
      expect(mem.events[i]!.id).toBe(`large-doc:chunk:${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — URL source
// ---------------------------------------------------------------------------

describe("ingestDocument — SSRF guard", () => {
  it("rejects a public-looking hostname when DNS includes loopback", async () => {
    const mem = fakeMemory();
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response("must not be reached");
    }) as typeof fetch;

    await expect(ingestDocument(
      { url: "https://files.example/document" },
      {
        memory: mem,
        scope: agentScope,
        fetchImpl,
        resolveHost: async () => ["93.184.216.34", "127.0.0.1"],
      },
    )).rejects.toThrow(/resolved host|non-global|blocked/i);
    expect(fetchCalls).toBe(0);
    expect(mem.events).toHaveLength(0);
  });

  it("rejects URL credentials", async () => {
    const mem = fakeMemory();
    await expect(ingestDocument(
      { url: "https://user:secret@example.com/document" },
      {
        memory: mem,
        scope: agentScope,
        fetchImpl: fakeFetch("never"),
        resolveHost: async () => ["93.184.216.34"],
      },
    )).rejects.toThrow(/credentials/i);
  });

  it("rejects fetched bodies above maxResponseBytes without ingesting a prefix", async () => {
    const mem = fakeMemory();
    await expect(ingestDocument(
      { url: "https://example.com/large" },
      {
        memory: mem,
        scope: agentScope,
        fetchImpl: fakeFetch("x".repeat(2048)),
        resolveHost: async () => ["93.184.216.34"],
        maxResponseBytes: 1024,
      },
    )).rejects.toThrow(/response body.*1024|exceeds.*1024/i);
    expect(mem.events).toHaveLength(0);
  });

  it("rejects binary media types", async () => {
    const mem = fakeMemory();
    const fetchImpl = (async () => new Response(new Uint8Array([0, 1, 2]), {
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;
    await expect(ingestDocument(
      { url: "https://example.com/file.bin" },
      {
        memory: mem,
        scope: agentScope,
        fetchImpl,
        resolveHost: async () => ["93.184.216.34"],
      },
    )).rejects.toThrow(/content type/i);
  });

  it("rejects cloud-metadata endpoint 169.254.169.254", async () => {
    const mem = fakeMemory();
    await expect(
      ingestDocument(
        { url: "http://169.254.169.254/latest/meta-data" },
        { memory: mem, scope: agentScope },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });

  it("rejects localhost", async () => {
    const mem = fakeMemory();
    await expect(
      ingestDocument(
        { url: "http://localhost/x" },
        { memory: mem, scope: agentScope },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    const mem = fakeMemory();
    await expect(
      ingestDocument(
        { url: "http://[::ffff:127.0.0.1]/x" },
        { memory: mem, scope: agentScope },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });

  it("allows a public URL with a fake fetch impl", async () => {
    const mem = fakeMemory();
    const result = await ingestDocument(
      { url: "https://example.com/doc.txt" },
      { memory: mem, scope: agentScope, docId: "ssrf-ok", fetchImpl: fakeFetch("hello world") },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.text).toBe("hello world");
  });

  it("allowlist restricts to listed hosts — rejects unlisted host", async () => {
    const mem = fakeMemory();
    await expect(
      ingestDocument(
        { url: "https://evil.example.com/doc.txt" },
        {
          memory: mem,
          scope: agentScope,
          allowlist: ["trusted.example.com"],
          fetchImpl: fakeFetch("never reached"),
        },
      ),
    ).rejects.toThrow(/allowlist/i);
    expect(mem.events).toHaveLength(0);
  });

  it("allowlist allows a matching host", async () => {
    const mem = fakeMemory();
    const result = await ingestDocument(
      { url: "https://trusted.example.com/doc.txt" },
      {
        memory: mem,
        scope: agentScope,
        allowlist: ["trusted.example.com"],
        fetchImpl: fakeFetch("trusted content"),
        resolveHost: async () => ["93.184.216.34"],
        docId: "allowed-doc",
      },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.text).toBe("trusted content");
  });

  it("rejects redirect to internal host", async () => {
    const mem = fakeMemory();
    // fakeFetch that returns a 302 to an internal address
    const redirectFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const url = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : _url.url;
      if (url === "https://example.com/redirect-me") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      return new Response("reached internal", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      ingestDocument(
        { url: "https://example.com/redirect-me" },
        { memory: mem, scope: agentScope, fetchImpl: redirectFetch },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — redirect-chain bypass (FIX 1: multi-hop redirect validation)
// ---------------------------------------------------------------------------

describe("ingestDocument — redirect chain SSRF guard (multi-hop, FIX 1)", () => {
  /**
   * Attack scenario: public → public → internal/metadata chain.
   * A server returns a public URL on hop 1, then that URL redirects to an
   * internal/metadata address on hop 2. Without per-hop re-validation the
   * internal address would be silently reached.
   */
  it("rejects a redirect chain whose SECOND hop points to cloud-metadata (169.254.169.254)", async () => {
    const mem = fakeMemory();
    const chainFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const url = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      if (url === "https://example.com/step1") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/step2" },
        });
      }
      if (url === "https://cdn.example.com/step2") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      return new Response("reached internal", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      ingestDocument(
        { url: "https://example.com/step1" },
        {
          memory: mem,
          scope: agentScope,
          fetchImpl: chainFetch,
          resolveHost: async () => ["93.184.216.34"],
        },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });

  /**
   * Attack scenario: redirect chain ends at 127.0.0.1 on hop 3.
   * Tests that ALL hops are validated, not just the first redirect.
   */
  it("rejects a redirect chain whose THIRD hop points to 127.0.0.1", async () => {
    const mem = fakeMemory();
    const chainFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const url = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      if (url === "https://example.com/a") {
        return new Response(null, { status: 301, headers: { location: "https://example.com/b" } });
      }
      if (url === "https://example.com/b") {
        return new Response(null, { status: 302, headers: { location: "https://example.com/c" } });
      }
      if (url === "https://example.com/c") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      }
      return new Response("reached internal", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      ingestDocument(
        { url: "https://example.com/a" },
        { memory: mem, scope: agentScope, fetchImpl: chainFetch },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(mem.events).toHaveLength(0);
  });

  /**
   * Normal public redirect chains (≤5 hops) must still succeed.
   */
  it("allows a normal public 2-hop redirect chain and returns document text", async () => {
    const mem = fakeMemory();
    const chainFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const url = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      if (url === "https://example.com/short") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/final-doc" },
        });
      }
      if (url === "https://example.com/final-doc") {
        return new Response("hello from final", { status: 200 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await ingestDocument(
      { url: "https://example.com/short" },
      { memory: mem, scope: agentScope, fetchImpl: chainFetch, docId: "redirect-ok" },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.text).toBe("hello from final");
  });

  /**
   * Exceeding the hop limit must be rejected to prevent infinite redirect
   * loops and denial-of-service via circular redirects.
   */
  it("rejects when hop count exceeds the maximum (>5 hops)", async () => {
    const mem = fakeMemory();
    const chainFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const url = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      const m = /\/hop\/(\d+)$/.exec(url);
      const n = m ? parseInt(m[1]!, 10) : 0;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/hop/${n + 1}` },
      });
    }) as unknown as typeof fetch;

    await expect(
      ingestDocument(
        { url: "https://example.com/hop/0" },
        { memory: mem, scope: agentScope, fetchImpl: chainFetch },
      ),
    ).rejects.toThrow(/redirect/i);
    expect(mem.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Chunk options threaded through
// ---------------------------------------------------------------------------

describe("ingestDocument — chunk options", () => {
  it("passes chunk size/overlap to chunkText", async () => {
    const mem = fakeMemory();
    const text = "word ".repeat(200);
    await ingestDocument(text, {
      memory: mem,
      scope: agentScope,
      docId: "d",
      chunk: { size: 200, overlap: 50 },
    });
    // With size=200 and ~1000 chars the number of chunks should be roughly 5
    expect(mem.events.length).toBeGreaterThanOrEqual(4);
    // Overlap: chunks after first should have the last 50 chars of prev chunk as prefix
    for (let i = 1; i < mem.events.length; i++) {
      const prev = mem.events[i - 1]!;
      const cur = mem.events[i]!;
      const prefix = prev.text.slice(-50);
      expect(cur.text.startsWith(prefix)).toBe(true);
    }
  });

  it("passes strategy to chunkText", async () => {
    const mem = fakeMemory();
    const text = "Para one.\n\nPara two.\n\nPara three.";
    await ingestDocument(text, {
      memory: mem,
      scope: agentScope,
      docId: "para-doc",
      chunk: { strategy: "paragraph", size: 1000, overlap: 0 },
    });
    // All paragraphs fit in one chunk
    expect(mem.events).toHaveLength(1);
    expect(mem.events[0]!.text).toContain("Para one");
    expect(mem.events[0]!.text).toContain("Para two");
  });
});

// ---------------------------------------------------------------------------
// FIX 4: plain string starting with http(s):// should emit a logger warning
// (likely misuse — they probably meant { url: "..." })
// ---------------------------------------------------------------------------

describe("ingestDocument — plain string URL-like misuse warning (FIX 4)", () => {
  it("emits a console.warn when a plain string source starts with https://", async () => {
    const mem = fakeMemory();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // This is treated as raw text (NOT fetched), but looks URL-like — should warn.
      await ingestDocument("https://example.com/should-be-url-source", {
        memory: mem,
        scope: agentScope,
        docId: "warn-test",
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      const warnMsg = (warnSpy.mock.calls[0]![0] as string);
      expect(warnMsg).toMatch(/url/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn for non-URL plain strings", async () => {
    const mem = fakeMemory();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ingestDocument("This is just plain document text.", {
        memory: mem,
        scope: agentScope,
        docId: "no-warn",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("plain string starting with https:// is treated as raw text (no fetch)", async () => {
    const mem = fakeMemory();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await ingestDocument("https://example.com/some-url", {
        memory: mem,
        scope: agentScope,
        docId: "raw-url-text",
      });
      // Must still ingest the string as raw text (existing behavior preserved)
      expect(result.chunks).toBe(1);
      expect(mem.events[0]!.text).toBe("https://example.com/some-url");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// M23: SSRF guard — fetchImpl auto-following redirect detection
// ---------------------------------------------------------------------------

describe("ingestDocument — auto-following fetchImpl detection (M23)", () => {
  /**
   * If a fetchImpl silently auto-follows a redirect (e.g. by not respecting
   * redirect:"manual"), the SSRF hop-by-hop guard is bypassed.  The runtime
   * assertion must detect this and throw a clear error so the operator can
   * fix their fetchImpl.
   */
  it("throws a clear error when fetchImpl auto-follows a redirect (redirected=true)", async () => {
    const mem = fakeMemory();
    // Simulate a fetchImpl that ignores redirect:"manual" and auto-follows:
    // it returns a 200 response but sets `redirected = true` and changes `url`.
    const autoFollowingFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const requestedUrl = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      // The fetch implementation silently followed a redirect to a different URL.
      const finalUrl = requestedUrl.replace("example.com", "redirected.example.com");
      const resp = new Response("auto-followed content", { status: 200 });
      // Patch response to look like it auto-followed.
      Object.defineProperty(resp, "redirected", { value: true, configurable: true });
      Object.defineProperty(resp, "url", { value: finalUrl, configurable: true });
      return resp;
    }) as unknown as typeof fetch;

    await expect(
      ingestDocument(
        { url: "https://example.com/page" },
        { memory: mem, scope: agentScope, fetchImpl: autoFollowingFetch },
      ),
    ).rejects.toThrow(/fetchImpl.*redirect.*manual|auto-followed|redirect:.*manual/i);
    expect(mem.events).toHaveLength(0);
  });

  it("does not throw when fetchImpl correctly returns the original URL with a 2xx", async () => {
    const mem = fakeMemory();
    // A well-behaved fetchImpl: honours redirect:"manual", returns 200 at the original URL.
    const goodFetch: typeof fetch = (async (_url: string | URL | Request) => {
      const requestedUrl = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : (_url as Request).url;
      const resp = new Response("good content", { status: 200 });
      Object.defineProperty(resp, "redirected", { value: false, configurable: true });
      Object.defineProperty(resp, "url", { value: requestedUrl, configurable: true });
      return resp;
    }) as unknown as typeof fetch;

    const result = await ingestDocument(
      { url: "https://example.com/good" },
      { memory: mem, scope: agentScope, fetchImpl: goodFetch, docId: "good-doc" },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.text).toBe("good content");
  });
});
