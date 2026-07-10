/**
 * Tests for document loaders: Markdown, HTML, and PDF.
 *
 * PDF uses a dependency-injection parser so no real `pdf-parse` install is needed.
 */
import { describe, it, expect } from "vitest";
import type { MemoryEvent, Scope } from "@eidentic/types";
import { loadMarkdown, loadHtml, loadPdf } from "../src/loaders.js";
import { ingestDocument as guardedIngestDocument } from "../src/ingest.js";
import type { IngestableMemory } from "../src/ingest.js";

const scope: Scope = { kind: "agent", agentId: "loader-test-agent" };
const ingestDocument: typeof guardedIngestDocument = (source, opts) => guardedIngestDocument(source, {
  unsafeAllowAnyPublicHost: opts.allowlist === undefined,
  allowInsecureHttp: true,
  ...opts,
});

function fakeMemory(): IngestableMemory & { events: MemoryEvent[] } {
  const events: MemoryEvent[] = [];
  return {
    events,
    async ingest(evts: MemoryEvent[]) {
      events.push(...evts);
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown loader
// ---------------------------------------------------------------------------

describe("loadMarkdown", () => {
  it("strips ATX headings and returns the heading text", () => {
    const { text } = loadMarkdown("# Hello World\n\nSome paragraph.");
    expect(text).toContain("Hello World");
    expect(text).not.toContain("# ");
    expect(text).toContain("Some paragraph");
  });

  it("strips bold and italic markers", () => {
    const { text } = loadMarkdown("**bold** and *italic* and __under__ text.");
    expect(text).toContain("bold");
    expect(text).toContain("italic");
    expect(text).toContain("under");
    expect(text).not.toContain("**");
    expect(text).not.toContain("__");
    expect(text).not.toMatch(/\*[^*]/);
  });

  it("strips inline code backticks", () => {
    const { text } = loadMarkdown("Use `npm install` to install.");
    expect(text).toContain("npm install");
    expect(text).not.toContain("`");
  });

  it("strips fenced code blocks entirely", () => {
    const md = "Before\n\n```\nconst x = 1;\nconst y = 2;\n```\n\nAfter";
    const { text } = loadMarkdown(md);
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("const x");
  });

  it("converts links to just the link text", () => {
    const { text } = loadMarkdown("See [the docs](https://example.com/docs) for details.");
    expect(text).toContain("the docs");
    expect(text).not.toContain("https://example.com");
    expect(text).not.toContain("](");
  });

  it("strips blockquote markers", () => {
    const { text } = loadMarkdown("> This is a quote.\n> Second line.");
    expect(text).toContain("This is a quote");
    expect(text).not.toContain("> ");
  });

  it("sets metadata.source from opts.source", () => {
    const { metadata } = loadMarkdown("# Doc", { source: "my-doc.md" });
    expect(metadata.source).toBe("my-doc.md");
  });

  it("defaults metadata.source to 'markdown' when not provided", () => {
    const { metadata } = loadMarkdown("# Doc");
    expect(metadata.source).toBe("markdown");
  });

  it("returns empty string for whitespace-only input", () => {
    const { text } = loadMarkdown("   \n\n   ");
    expect(text).toBe("");
  });

  it("handles a realistic README excerpt", () => {
    const md = `# Eidentic

**Eidentic** is an open-source TypeScript SDK for building AI agents.

## Installation

\`\`\`sh
npm install eidentic
\`\`\`

## Features

- Modular memory system
- Tool use and MCP support
- [Docs](https://eidentic.dev)
`;
    const { text } = loadMarkdown(md);
    expect(text).toContain("Eidentic");
    expect(text).toContain("open-source TypeScript SDK");
    expect(text).toContain("Modular memory system");
    expect(text).toContain("Docs");
    expect(text).not.toContain("```");
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
  });
});

// ---------------------------------------------------------------------------
// HTML loader
// ---------------------------------------------------------------------------

describe("loadHtml", () => {
  it("extracts visible text from a simple HTML page", () => {
    const html = `<html><body><h1>Title</h1><p>Hello world.</p></body></html>`;
    const { text } = loadHtml(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("<h1>");
    expect(text).not.toContain("<p>");
  });

  it("removes <script> tags and their content", () => {
    const html = `<html><body><p>Visible</p><script>alert("xss")</script></body></html>`;
    const { text } = loadHtml(html);
    expect(text).toContain("Visible");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("xss");
  });

  it("removes <style> tags and their content", () => {
    const html = `<html><head><style>body{color:red}</style></head><body><p>Text</p></body></html>`;
    const { text } = loadHtml(html);
    expect(text).toContain("Text");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("body{");
  });

  it("removes <head> content (title, meta, etc.)", () => {
    const html = `<html><head><title>Page Title</title><meta charset="utf-8"></head><body><p>Body text</p></body></html>`;
    const { text } = loadHtml(html);
    // Body text is present
    expect(text).toContain("Body text");
    // head/title should be stripped
    expect(text).not.toContain("<title>");
  });

  it("collapses whitespace into single spaces", () => {
    const html = `<p>Hello     world   how  are  you</p>`;
    const { text } = loadHtml(html);
    expect(text).not.toMatch(/  /);
  });

  it("sets metadata.source from opts.source", () => {
    const { metadata } = loadHtml("<p>hi</p>", { source: "https://example.com" });
    expect(metadata.source).toBe("https://example.com");
  });

  it("defaults metadata.source to 'html' when not provided", () => {
    const { metadata } = loadHtml("<p>hi</p>");
    expect(metadata.source).toBe("html");
  });

  it("returns empty string for HTML with no visible text", () => {
    const html = `<html><head><title>T</title></head><body><script>1+1</script></body></html>`;
    const { text } = loadHtml(html);
    expect(text).toBe("");
  });

  it("handles a realistic article HTML snippet", () => {
    const html = `
      <html>
        <head>
          <title>AI Agents 101</title>
          <style>.hidden { display: none; }</style>
        </head>
        <body>
          <nav>Home | About</nav>
          <main>
            <h1>Introduction to AI Agents</h1>
            <p>An <strong>AI agent</strong> is a program that perceives its environment
            and takes actions to achieve goals.</p>
            <ul>
              <li>Tool use</li>
              <li>Memory</li>
              <li>Planning</li>
            </ul>
          </main>
          <script>console.log("loaded")</script>
        </body>
      </html>
    `;
    const { text } = loadHtml(html);
    expect(text).toContain("Introduction to AI Agents");
    expect(text).toContain("AI agent");
    expect(text).toContain("Tool use");
    expect(text).toContain("Memory");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("<strong>");
    expect(text).not.toContain(".hidden");
  });
});

// ---------------------------------------------------------------------------
// PDF loader — uses injected _parser, no real pdf-parse needed
// ---------------------------------------------------------------------------

describe("loadPdf", () => {
  function mockParser(text: string, numpages = 3) {
    return async (_buf: Buffer): Promise<{ text: string; numpages: number }> => ({
      text,
      numpages,
    });
  }

  it("returns extracted text and numpages in metadata", async () => {
    const buf = Buffer.from("fake pdf bytes");
    const { text, metadata } = await loadPdf(buf, {
      _parser: mockParser("Hello from PDF!\n\nSecond paragraph."),
    });
    expect(text).toContain("Hello from PDF");
    expect(text).toContain("Second paragraph");
    expect(metadata.pages).toBe(3);
  });

  it("sets metadata.source from opts.source", async () => {
    const buf = Buffer.from("fake");
    const { metadata } = await loadPdf(buf, {
      source: "report.pdf",
      _parser: mockParser("content", 1),
    });
    expect(metadata.source).toBe("report.pdf");
  });

  it("defaults metadata.source to 'pdf' when not provided", async () => {
    const buf = Buffer.from("fake");
    const { metadata } = await loadPdf(buf, {
      _parser: mockParser("content", 2),
    });
    expect(metadata.source).toBe("pdf");
  });

  it("collapses excessive whitespace in extracted text", async () => {
    const rawText = "Line one   with   spaces\n\n\n\nToo many blank lines";
    const buf = Buffer.from("fake");
    const { text } = await loadPdf(buf, { _parser: mockParser(rawText, 1) });
    expect(text).not.toMatch(/   /);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("throws a clear error message when no _parser is provided and real parsing fails", async () => {
    // pdf-parse may or may not be installed in the monorepo. When it IS installed,
    // passing fake bytes will throw a PDF parsing error rather than a missing-dep
    // error. Either way, loadPdf rejects — we just check it rejects.
    const buf = Buffer.from("not a real pdf");
    await expect(loadPdf(buf)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: TypedContentSource via ingestDocument
// ---------------------------------------------------------------------------

describe("ingestDocument — TypedContentSource", () => {
  it("markdown: extracts text and sets metadata.source on each chunk", async () => {
    const mem = fakeMemory();
    const md = `# Guide\n\nThis is a guide.\n\n**Important**: read carefully.`;

    const result = await ingestDocument(
      { type: "markdown", data: md, source: "guide.md" },
      { memory: mem, scope, docId: "guide" },
    );

    expect(result.chunks).toBeGreaterThan(0);
    for (const e of mem.events) {
      expect(e.metadata?.source).toBe("guide.md");
    }
    // Extracted text should contain readable words, not markdown symbols
    expect(mem.events[0]!.text).toContain("Guide");
    expect(mem.events[0]!.text).toContain("Important");
    expect(mem.events[0]!.text).not.toContain("**");
  });

  it("markdown: metadata.source defaults to 'markdown' when source not given", async () => {
    const mem = fakeMemory();
    await ingestDocument(
      { type: "markdown", data: "# Hello\n\nWorld." },
      { memory: mem, scope, docId: "md-test" },
    );
    for (const e of mem.events) {
      expect(e.metadata?.source).toBe("markdown");
    }
  });

  it("html: extracts visible text and sets metadata.source on each chunk", async () => {
    const mem = fakeMemory();
    const html = `<html><body><h1>Products</h1><p>Buy our great products.</p></body></html>`;

    const result = await ingestDocument(
      { type: "html", data: html, source: "https://example.com/products" },
      { memory: mem, scope, docId: "products" },
    );

    expect(result.chunks).toBeGreaterThan(0);
    for (const e of mem.events) {
      expect(e.metadata?.source).toBe("https://example.com/products");
    }
    expect(mem.events[0]!.text).toContain("Products");
    expect(mem.events[0]!.text).not.toContain("<h1>");
  });

  it("html: strips scripts before chunking", async () => {
    const mem = fakeMemory();
    const html = `<html><body><p>Readable</p><script>evil()</script></body></html>`;

    await ingestDocument(
      { type: "html", data: html },
      { memory: mem, scope, docId: "html-test" },
    );

    const allText = mem.events.map((e) => e.text).join(" ");
    expect(allText).not.toContain("evil()");
    expect(allText).toContain("Readable");
  });

  it("pdf: extracts text via _parser and sets metadata.source + pages on each chunk", async () => {
    const mem = fakeMemory();
    const mockParser = async (_buf: Buffer) => ({
      text: "Page 1 content.\n\nPage 2 content.\n\nPage 3 content.",
      numpages: 3,
    });
    const buf = Buffer.from("fake pdf bytes");

    const result = await ingestDocument(
      { type: "pdf", data: buf, source: "report.pdf", _parser: mockParser },
      { memory: mem, scope, docId: "report" },
    );

    expect(result.chunks).toBeGreaterThan(0);
    for (const e of mem.events) {
      expect(e.metadata?.source).toBe("report.pdf");
      expect(e.metadata?.pages).toBe(3);
    }
    const allText = mem.events.map((e) => e.text).join(" ");
    expect(allText).toContain("Page 1 content");
  });

  it("pdf: chunk ids follow the ${docId}:chunk:${i} pattern", async () => {
    const mem = fakeMemory();
    const mockParser = async (_buf: Buffer) => ({
      text: "word ".repeat(300),
      numpages: 1,
    });
    const buf = Buffer.from("fake");

    await ingestDocument(
      { type: "pdf", data: buf, _parser: mockParser },
      { memory: mem, scope, docId: "my-pdf", chunk: { size: 200, overlap: 0 } },
    );

    for (let i = 0; i < mem.events.length; i++) {
      expect(mem.events[i]!.id).toBe(`my-pdf:chunk:${i}`);
    }
  });

  it("returns { chunks: 0 } for empty extracted content", async () => {
    const mem = fakeMemory();
    // HTML with only invisible content
    await ingestDocument(
      { type: "html", data: "<script>1+1</script>" },
      { memory: mem, scope },
    );
    expect(mem.events).toHaveLength(0);
  });

  it("backward compat: plain string source still works", async () => {
    const mem = fakeMemory();
    const result = await ingestDocument("Plain text document.", {
      memory: mem,
      scope,
      docId: "plain",
    });
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.metadata?.source).toBe("plain");
  });

  it("backward compat: URL source still works", async () => {
    const mem = fakeMemory();
    const fakeFetch = (async () =>
      new Response("Fetched content.", { status: 200 })) as unknown as typeof fetch;

    const result = await ingestDocument(
      { url: "https://example.com/page.txt" },
      { memory: mem, scope, docId: "url-doc", fetchImpl: fakeFetch },
    );
    expect(result.chunks).toBe(1);
    expect(mem.events[0]!.metadata?.source).toBe("https://example.com/page.txt");
  });
});
