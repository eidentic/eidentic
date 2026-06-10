import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunk.js";
import type { Chunk } from "../src/chunk.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the fundamental invariants of a chunk array. */
function assertChunkInvariants(chunks: Chunk[], originalText: string) {
  const normalized = originalText.trim();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    expect(c.index).toBe(i);
    expect(c.text.length).toBeGreaterThan(0);
    // start/end must be within the normalized text
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.end).toBeLessThanOrEqual(normalized.length);
    expect(c.end).toBeGreaterThan(c.start);
    // the raw slice must match (without overlap prefix, which may extend before start)
    expect(normalized.slice(c.start, c.end).trim().length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Empty / whitespace
// ---------------------------------------------------------------------------

describe("chunkText — empty / whitespace", () => {
  it("returns [] for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("returns one chunk for a short string", () => {
    const result = chunkText("hello world");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("hello world");
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.start).toBe(0);
    expect(result[0]!.end).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Fixed strategy — basics
// ---------------------------------------------------------------------------

describe("chunkText — fixed strategy", () => {
  it("produces multiple chunks for long text", () => {
    const text = "word ".repeat(300); // ~1500 chars
    const chunks = chunkText(text, { size: 500, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    assertChunkInvariants(chunks, text);
  });

  it("does not split mid-word", () => {
    // 10 50-char words separated by spaces (550 chars total)
    const word = "a".repeat(50);
    const text = Array.from({ length: 10 }, () => word).join(" ");
    const chunks = chunkText(text, { size: 100, overlap: 0 });
    for (const c of chunks) {
      // Each chunk should consist only of complete words
      const words = c.text.split(" ").filter((w) => w.length > 0);
      for (const w of words) {
        expect(w.length).toBe(50); // not cut in the middle
      }
    }
  });

  it("handles a single very long word (no whitespace)", () => {
    const longWord = "x".repeat(3000);
    const chunks = chunkText(longWord, { size: 1000, overlap: 0 });
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
    }
    // Concatenation must equal original
    expect(chunks.map((c) => c.text).join("")).toBe(longWord);
  });

  it("indices are sequential and start/end are consistent", () => {
    const text = "word ".repeat(400);
    const chunks = chunkText(text, { size: 300, overlap: 0 });
    assertChunkInvariants(chunks, text);
    for (let i = 1; i < chunks.length; i++) {
      // start of next chunk >= end of previous (no backward jumps)
      expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.start);
    }
  });
});

// ---------------------------------------------------------------------------
// Overlap correctness
// ---------------------------------------------------------------------------

describe("chunkText — overlap", () => {
  it("first chunk has no overlap prefix", () => {
    const text = "alpha beta gamma " + "word ".repeat(200);
    const chunks = chunkText(text, { size: 200, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk text must start exactly at start of text (no prefix)
    const norm = text.trim();
    expect(chunks[0]!.text).toBe(norm.slice(0, chunks[0]!.end).trim());
  });

  it("subsequent chunks have overlap prefix from previous chunk", () => {
    // Build text that results in 3+ chunks
    const text = "word ".repeat(600);
    const chunks = chunkText(text, { size: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      // The first 100 chars of cur.text should match the last 100 chars of prev.text
      const expectedPrefix = prev.text.slice(-100);
      expect(cur.text.startsWith(expectedPrefix)).toBe(true);
    }
  });

  it("overlap=0 means no prefix on subsequent chunks", () => {
    const text = "word ".repeat(600);
    const chunks = chunkText(text, { size: 500, overlap: 0 });
    // With overlap=0 the chunk text itself (without prefix) should equal the raw slice
    const norm = text.trim();
    for (const c of chunks) {
      // The chunk text must match what the original text has at [start, end)
      expect(c.text.trim()).toBe(norm.slice(c.start, c.end).trim());
    }
    // All words appear across all chunks
    const allChunkText = chunks.map((c) => c.text).join(" ");
    const originalWords = norm.split(/\s+/).filter(Boolean);
    // Every unique word present in the original should appear in the full reconstructed text
    const uniqueWords = [...new Set(originalWords)];
    for (const w of uniqueWords) {
      expect(allChunkText).toContain(w);
    }
  });

  it("overlap is capped to size-1 when too large", () => {
    const text = "word ".repeat(400);
    // overlap > size — should be capped silently
    const chunks = chunkText(text, { size: 100, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(0);
    // No chunk should be completely empty
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Unicode
// ---------------------------------------------------------------------------

describe("chunkText — unicode", () => {
  it("handles multi-byte unicode characters without corrupting them", () => {
    // Each emoji is 2 code units / 4 bytes; chunkText works with string.length (code units)
    const emoji = "😀";
    const text = (emoji + " ").repeat(500); // ~2000 chars
    const chunks = chunkText(text, { size: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should contain a broken/partial surrogate — every char should roundtrip
    for (const c of chunks) {
      expect(Buffer.from(c.text, "utf8").toString("utf8")).toBe(c.text);
    }
  });

  it("handles CJK (no whitespace separators) — falls back to hard cut", () => {
    // Chinese chars have no spaces between them — will force hard cuts at size
    const chinese = "你好世界".repeat(300); // 1200 chars
    const chunks = chunkText(chinese, { size: 400, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // All chars covered (some may be duplicated by overlap but with overlap=0 they shouldn't be)
    const combined = chunks.map((c) => c.text).join("");
    expect(combined).toBe(chinese);
  });
});

// ---------------------------------------------------------------------------
// Paragraph strategy
// ---------------------------------------------------------------------------

describe("chunkText — paragraph strategy", () => {
  it("splits on blank lines", () => {
    const p1 = "First paragraph content here.";
    const p2 = "Second paragraph content here.";
    const p3 = "Third paragraph content here.";
    const text = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = chunkText(text, { strategy: "paragraph", size: 1000, overlap: 0 });
    // All three fit in one chunk since they're small
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain(p1);
    expect(chunks[0]!.text).toContain(p2);
    expect(chunks[0]!.text).toContain(p3);
  });

  it("splits large paragraphs into multiple chunks", () => {
    const bigParagraph = "word ".repeat(400); // ~2000 chars
    const chunks = chunkText(bigParagraph, { strategy: "paragraph", size: 500, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    assertChunkInvariants(chunks, bigParagraph);
  });

  it("respects overlap across paragraph-derived chunks", () => {
    const text = ("word ".repeat(200) + "\n\n").repeat(3);
    const chunks = chunkText(text, { strategy: "paragraph", size: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      const prefix = prev.text.slice(-50);
      expect(cur.text.startsWith(prefix)).toBe(true);
    }
  });

  it("returns one chunk when text fits within size", () => {
    const text = "Short text.\n\nAnother short paragraph.";
    const chunks = chunkText(text, { strategy: "paragraph", size: 1000, overlap: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sentence strategy
// ---------------------------------------------------------------------------

describe("chunkText — sentence strategy", () => {
  it("splits on sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const chunks = chunkText(text, { strategy: "sentence", size: 1000, overlap: 0 });
    // All sentences fit in one chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(text.trim());
  });

  it("produces multiple chunks for long sentence sequences", () => {
    const sentence = "This is a sentence with some words. ";
    const text = sentence.repeat(50); // ~1800 chars
    const chunks = chunkText(text, { strategy: "sentence", size: 200, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    assertChunkInvariants(chunks, text);
  });

  it("handles exclamation and question marks", () => {
    const text = "Hello! How are you? I am fine. Great news! Really?";
    const chunks = chunkText(text, { strategy: "sentence", size: 1000, overlap: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(text.trim());
  });

  it("falls back to word-boundary split for long single sentences", () => {
    const longSentence = "word ".repeat(500); // ~2500 chars, no sentence break
    const chunks = chunkText(longSentence, { strategy: "sentence", size: 500, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

describe("chunkText — default options", () => {
  it("uses size=1000 and overlap=150 by default", () => {
    const text = "word ".repeat(800); // ~4000 chars
    const defaultChunks = chunkText(text);
    const explicitChunks = chunkText(text, { size: 1000, overlap: 150 });

    expect(defaultChunks.length).toBe(explicitChunks.length);
    for (let i = 0; i < defaultChunks.length; i++) {
      expect(defaultChunks[i]!.text).toBe(explicitChunks[i]!.text);
    }
  });

  it("uses fixed strategy by default", () => {
    const text = "word ".repeat(200);
    const def = chunkText(text, { size: 100, overlap: 0 });
    const fixed = chunkText(text, { size: 100, overlap: 0, strategy: "fixed" });
    expect(def.map((c) => c.text)).toEqual(fixed.map((c) => c.text));
  });
});
