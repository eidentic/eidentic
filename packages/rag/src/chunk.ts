/**
 * Text chunking for RAG document ingestion.
 *
 * Three strategies:
 *   "fixed"     — slide a fixed-size window, breaking on word boundaries near the size limit.
 *   "paragraph" — split on blank-line paragraph breaks first, then fall back to word boundary
 *                 splits for paragraphs that are too long.
 *   "sentence"  — split on sentence-ending punctuation (., !, ?) first, then fall back to word
 *                 boundary splits for sentences that are too long.
 *
 * All strategies respect `overlap`: the last `overlap` characters of the previous chunk are
 * prepended to the next chunk so retrieval can straddle boundaries.
 */

/** One text chunk produced by {@link chunkText}. */
export interface Chunk {
  /** The chunk text (may include overlap prefix from the previous chunk). */
  text: string;
  /** Zero-based chunk index. */
  index: number;
  /** Start byte-offset in the *original* text (without overlap prefix). */
  start: number;
  /** End byte-offset in the *original* text (exclusive). */
  end: number;
}

/** Options for {@link chunkText}. */
export interface ChunkOptions {
  /**
   * Target chunk size in characters. The actual chunk may be slightly smaller or larger if it
   * is hard to find a clean boundary near the limit. Default: 1000.
   */
  size?: number;
  /**
   * Overlap in characters — how many characters from the end of the previous chunk to prepend
   * to the next one. Must be < size. Default: 150.
   */
  overlap?: number;
  /**
   * Chunking strategy:
   *   - "fixed"     — word-boundary window sliding over the whole text (default).
   *   - "paragraph" — prefer blank-line boundaries; large paragraphs are further split.
   *   - "sentence"  — prefer sentence-ending boundaries; long runs are further split.
   */
  strategy?: "fixed" | "paragraph" | "sentence";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Split `text` into word-boundary aligned segments no larger than `size` chars. */
function splitByWordBoundary(text: string, size: number): string[] {
  if (text.length <= size) return text ? [text] : [];
  const segments: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (pos + size >= text.length) {
      segments.push(text.slice(pos));
      break;
    }
    // Look backward from pos+size for a whitespace boundary.
    let cut = pos + size;
    while (cut > pos && !/\s/.test(text[cut]!)) cut--;
    if (cut === pos) {
      // No whitespace found — the word is very long; cut hard at size.
      cut = pos + size;
    } else {
      // Advance past the whitespace so the next segment doesn't start with it.
      while (cut < text.length && /\s/.test(text[cut]!)) cut++;
    }
    segments.push(text.slice(pos, cut).trimEnd());
    pos = cut;
  }
  return segments.filter((s) => s.length > 0);
}

/** Split `text` on blank-line paragraph boundaries. */
function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Split `text` on sentence-ending punctuation. */
function splitIntoSentences(text: string): string[] {
  // Split after ., !, ? followed by a space or end-of-string (handles abbreviations poorly but
  // adequately for document ingestion — good enough for a "sentence" strategy).
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Given a list of "natural" segments (paragraphs or sentences), pack them into
 * `size`-limited chunks, with `overlap` characters from the previous chunk prepended.
 *
 * Each returned item carries `{ text, start, end }` relative to the original source.
 */
function packSegments(
  segments: string[],
  source: string,
  size: number,
  overlap: number,
  separator: string = "\n\n",
): Array<{ text: string; start: number; end: number }> {
  // We need to map each segment back to its offset in `source`. We'll do a single
  // forward scan so we only walk `source` once.
  const segmentOffsets: Array<{ start: number; end: number; text: string }> = [];
  let searchFrom = 0;
  for (const seg of segments) {
    const idx = source.indexOf(seg, searchFrom);
    if (idx === -1) {
      // Fallback — shouldn't happen with clean splits, but be defensive.
      const prev = segmentOffsets[segmentOffsets.length - 1];
      const fallbackStart = prev ? prev.end : 0;
      segmentOffsets.push({ start: fallbackStart, end: fallbackStart + seg.length, text: seg });
      searchFrom = fallbackStart + seg.length;
    } else {
      segmentOffsets.push({ start: idx, end: idx + seg.length, text: seg });
      searchFrom = idx + seg.length;
    }
  }

  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let current: typeof segmentOffsets = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length === 0) return;
    const start = current[0]!.start;
    const end = current[current.length - 1]!.end;
    const text = current.map((s) => s.text).join(separator);
    chunks.push({ text, start, end });
    current = [];
    currentLen = 0;
  };

  for (const seg of segmentOffsets) {
    // If adding this segment would exceed size and we already have content, flush first.
    if (currentLen > 0 && currentLen + separator.length + seg.text.length > size) {
      flush();
    }
    // If a single segment is itself larger than `size`, split it further by word boundary.
    if (seg.text.length > size) {
      flush();
      const subSegs = splitByWordBoundary(seg.text, size);
      let subOffset = seg.start;
      for (const sub of subSegs) {
        const subStart = source.indexOf(sub, subOffset);
        const actualStart = subStart === -1 ? subOffset : subStart;
        chunks.push({ text: sub, start: actualStart, end: actualStart + sub.length });
        subOffset = actualStart + sub.length;
      }
      continue;
    }
    current.push(seg);
    currentLen += (currentLen > 0 ? separator.length : 0) + seg.text.length;
  }
  flush();

  // Apply overlap: prepend the last `overlap` chars of the previous chunk.
  return chunks.map((chunk, i) => {
    if (i === 0 || overlap === 0) return chunk;
    const prev = chunks[i - 1]!;
    const prefix = prev.text.slice(-overlap);
    return { text: prefix + chunk.text, start: chunk.start, end: chunk.end };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split `text` into overlapping chunks suitable for embedding and retrieval.
 *
 * Returns an empty array for empty/whitespace-only input.
 */
export function chunkText(text: string, opts?: ChunkOptions): Chunk[] {
  const size = opts?.size ?? 1000;
  const overlap = Math.min(opts?.overlap ?? 150, size - 1);
  const strategy = opts?.strategy ?? "fixed";

  // Normalise: collapse leading/trailing whitespace but preserve internal structure.
  const normalized = text.trim();
  if (normalized.length === 0) return [];

  if (strategy === "paragraph" || strategy === "sentence") {
    const naturalSegments =
      strategy === "paragraph"
        ? splitIntoParagraphs(normalized)
        : splitIntoSentences(normalized);

    const separator = strategy === "sentence" ? " " : "\n\n";
    const packed = packSegments(naturalSegments, normalized, size, overlap, separator);
    return packed.map((c, i) => ({ text: c.text, index: i, start: c.start, end: c.end }));
  }

  // "fixed" strategy — word-boundary sliding window.
  const chunks: Chunk[] = [];
  let pos = 0;
  let index = 0;

  while (pos < normalized.length) {
    // Determine the end of this chunk — try to break on a word boundary.
    let end = pos + size;
    if (end >= normalized.length) {
      end = normalized.length;
    } else {
      // Walk backward to find whitespace.
      let cut = end;
      while (cut > pos && !/\s/.test(normalized[cut]!)) cut--;
      if (cut === pos) {
        // No whitespace — very long word; cut hard.
        cut = end;
      }
      end = cut;
    }

    const chunkText = normalized.slice(pos, end).trim();
    if (chunkText.length > 0) {
      // Build the chunk text: prepend overlap from previous chunk.
      let fullText = chunkText;
      if (index > 0 && overlap > 0) {
        const prev = chunks[chunks.length - 1]!;
        const prefix = prev.text.slice(-overlap);
        fullText = prefix + chunkText;
      }
      chunks.push({ text: fullText, index, start: pos, end });
      index++;
    }

    // Advance: skip over any trailing whitespace so next chunk doesn't start with spaces.
    let next = end;
    while (next < normalized.length && /\s/.test(normalized[next]!)) next++;
    if (next === pos) {
      // Safety: avoid infinite loop if somehow pos didn't advance.
      break;
    }
    pos = next;
  }

  return chunks;
}
