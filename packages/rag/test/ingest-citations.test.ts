/**
 * Feature 3 — RAG citations: ingestDocument attaches metadata.source per chunk.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import type { MemoryEvent, Scope } from "@eidentic/types";
import { ingestDocument as guardedIngestDocument } from "../src/ingest.js";

const scope: Scope = { kind: "agent", agentId: "test-rag-agent" };
const ingestDocument: typeof guardedIngestDocument = (source, opts) => guardedIngestDocument(source, {
  unsafeAllowAnyPublicHost: opts.allowlist === undefined,
  allowInsecureHttp: true,
  ...opts,
});

/** A simple memory that records all ingested events for inspection. */
class CapturingMemory {
  readonly captured: MemoryEvent[] = [];
  async ingest(events: MemoryEvent[]): Promise<void> {
    this.captured.push(...events);
  }
}

describe("Feature 3 — ingestDocument attaches metadata.source per chunk", () => {
  it("plain text ingestion: metadata.source equals the computed docId", async () => {
    const mem = new CapturingMemory();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(5);

    const result = await ingestDocument(text, {
      memory: mem,
      scope,
      docId: "my-test-doc",
    });

    expect(result.chunks).toBeGreaterThan(0);
    expect(mem.captured).toHaveLength(result.chunks);

    // Every chunk must have metadata.source set to the docId.
    for (const event of mem.captured) {
      expect(event.metadata).toBeDefined();
      expect(event.metadata?.source).toBe("my-test-doc");
    }
  });

  it("plain text without explicit docId: metadata.source equals the auto-computed docId", async () => {
    const mem = new CapturingMemory();
    const text = "Artificial intelligence is transforming industries worldwide. ".repeat(3);

    const result = await ingestDocument(text, { memory: mem, scope });

    expect(result.chunks).toBeGreaterThan(0);
    // docId is auto-computed as a hash slug — should be a non-empty string.
    for (const event of mem.captured) {
      expect(event.metadata?.source).toBeTruthy();
      expect(typeof event.metadata?.source).toBe("string");
    }
  });

  it("URL source: metadata.source equals the fetched URL (not the docId)", async () => {
    const mem = new CapturingMemory();
    const targetUrl = "https://example.com/docs/guide";

    // Mock fetch: returns plain text to avoid any real network call.
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response("Cloud computing enables on-demand access to computing resources. ".repeat(5), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    const result = await ingestDocument(
      { url: targetUrl },
      {
        memory: mem,
        scope,
        fetchImpl: mockFetch as typeof fetch,
      },
    );

    expect(result.chunks).toBeGreaterThan(0);

    // For URL sources, metadata.source must be the URL itself.
    for (const event of mem.captured) {
      expect(event.metadata).toBeDefined();
      expect(event.metadata?.source).toBe(targetUrl);
    }
  });

  it("URL citations omit credentials, query strings and fragments", async () => {
    const memory = new CapturingMemory();
    await ingestDocument(
      { url: "https://example.com/document?token=secret#section" },
      {
        memory,
        scope,
        fetchImpl: async () => new Response("safe text"),
        resolveHost: async () => ["93.184.216.34"],
      },
    );

    expect(memory.captured[0]!.metadata?.source).toBe("https://example.com/document");
  });

  it("URL citations use the final validated redirect URL", async () => {
    const memory = new CapturingMemory();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://example.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/final?signature=secret#section" },
        });
      }
      return new Response("redirected document", {
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    await ingestDocument(
      { url: "https://example.com/start" },
      {
        memory,
        scope,
        fetchImpl,
        resolveHost: async () => ["93.184.216.34"],
      },
    );
    expect(memory.captured[0]!.metadata?.source).toBe("https://cdn.example.com/final");
  });

  it("chunk ids are stable: ${docId}:chunk:${i} with correct chunk count", async () => {
    const mem = new CapturingMemory();
    const text = "Kubernetes orchestrates containerized applications. ".repeat(10);

    const result = await ingestDocument(text, {
      memory: mem,
      scope,
      docId: "k8s-doc",
    });

    expect(mem.captured).toHaveLength(result.chunks);
    mem.captured.forEach((event, i) => {
      expect(event.id).toBe(`k8s-doc:chunk:${i}`);
      expect(event.metadata?.source).toBe("k8s-doc");
    });
  });

  it("empty source returns { chunks: 0 } and no events are ingested", async () => {
    const mem = new CapturingMemory();

    const result = await ingestDocument("", { memory: mem, scope });

    expect(result.chunks).toBe(0);
    expect(mem.captured).toHaveLength(0);
  });
});
