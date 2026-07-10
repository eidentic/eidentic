import { createRequire } from "node:module";
import { parse as parseHtml } from "node-html-parser";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** The extracted text and metadata from a document loader. */
export interface LoadedDocument {
  /** Plain text extracted from the document. */
  text: string;
  /** Metadata attached to each ingested chunk. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Markdown loader — pure JS regex-based stripper, no external deps.
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadMarkdown}.
 */
export interface MarkdownLoaderOptions {
  /** Stable source identifier placed into `metadata.source`. Defaults to `"markdown"`. */
  source?: string;
}

/**
 * Strip Markdown syntax and return plain readable text.
 *
 * Handles: headings, bold/italic/code spans, links/images, fenced/indented code blocks,
 * blockquotes, horizontal rules, and HTML tags embedded in MD.
 * Does NOT require any external dependency — pure regex.
 */
export function loadMarkdown(
  content: string,
  opts?: MarkdownLoaderOptions,
): LoadedDocument {
  const source = opts?.source ?? "markdown";

  let text = content;

  // Remove fenced code blocks (``` ... ```)
  text = text.replace(/```[\s\S]*?```/g, "");

  // Remove indented code blocks (4-space or tab indented lines)
  text = text.replace(/^(?:    |\t).+$/gm, "");

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Convert ATX headings (# Heading) — keep text, remove hashes
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Remove setext heading underlines (=== / --- lines)
  text = text.replace(/^[=-]{2,}\s*$/gm, "");

  // Remove horizontal rules (---, ***, ___)
  text = text.replace(/^(?:[*_-][\s]*){3,}$/gm, "");

  // Strip images: ![alt](url "title") → alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Strip links: [text](url "title") → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Strip reference-style links: [text][ref] → text
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // Strip link reference definitions: [ref]: url "title"
  text = text.replace(/^\[[^\]]+\]:\s+\S+(?:\s+"[^"]*")?$/gm, "");

  // Bold and italic: **text**, __text__, *text*, _text_
  text = text.replace(/\*{1,2}([^*\n]+)\*{1,2}/g, "$1");
  text = text.replace(/_{1,2}([^_\n]+)_{1,2}/g, "$1");

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, "$1");

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Blockquotes: > text → text
  text = text.replace(/^>\s?/gm, "");

  // Unordered list markers: - / * / + at line start
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");

  // Ordered list markers: 1. / 2. etc at line start
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // Collapse multiple blank lines into at most two
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  text = text.trim();

  return { text, metadata: { source } };
}

// ---------------------------------------------------------------------------
// HTML loader — node-html-parser (lightweight, no headless browser).
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadHtml}.
 */
export interface HtmlLoaderOptions {
  /** Stable source identifier placed into `metadata.source`. Defaults to `"html"`. */
  source?: string;
}

// Block-level tags that should produce newlines in plain text output.
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "aside", "main", "header", "footer",
  "nav", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "dt", "dd", "ul", "ol",
  "blockquote", "pre", "figure", "figcaption",
  "br", "hr",
  "tr", "th", "td", "table",
]);

/**
 * Extract readable text from an HTML string.
 *
 * Removes `<script>`, `<style>`, `<head>`, and `<noscript>` elements, then
 * walks the DOM collecting text nodes. Collapses runs of whitespace and
 * preserves newlines at block-level boundaries.
 *
 * Uses `node-html-parser` — a lightweight HTML parser with no headless
 * browser requirement.
 */
export function loadHtml(
  html: string,
  opts?: HtmlLoaderOptions,
): LoadedDocument {
  const source = opts?.source ?? "html";

  const root = parseHtml(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: {
      script: false,
      style: false,
      noscript: false,
      pre: true,
    },
  });

  // Remove non-content elements
  for (const tag of ["script", "style", "noscript", "head"]) {
    for (const el of root.querySelectorAll(tag)) {
      el.remove();
    }
  }

  // node-html-parser node types: 1=ELEMENT, 3=TEXT
  type HtmlNode = { nodeType: number; rawText?: string; text: string; tagName?: string; childNodes: HtmlNode[] };

  function extractText(node: HtmlNode): string {
    if (node.nodeType === 3) {
      // Text node: use rawText to preserve exact content before HTML entity decoding
      return node.rawText ?? node.text ?? "";
    }

    const tag = node.tagName?.toLowerCase() ?? "";
    const isBlock = BLOCK_TAGS.has(tag);
    const childText = node.childNodes.map((c) => extractText(c)).join("");

    return isBlock ? `\n${childText}\n` : childText;
  }

  let text = extractText(root as unknown as HtmlNode);

  // Collapse multiple spaces/tabs on each line (but not newlines)
  text = text.replace(/[^\S\n]+/g, " ");
  // Collapse 3+ consecutive newlines into 2
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return { text, metadata: { source } };
}

// ---------------------------------------------------------------------------
// PDF loader — optional peer dep `pdf-parse`.
//              Mirrors the ollama lazy-require pattern from @eidentic/model.
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadPdf}.
 */
export interface PdfLoaderOptions {
  /** Stable source identifier placed into `metadata.source`. Defaults to `"pdf"`. */
  source?: string;
  /**
   * Injectable parser function for testing — when provided, `pdf-parse` is NOT
   * dynamically imported. Must accept a `Buffer` and return a promise of
   * `{ text: string; numpages: number }`.
   * @internal
   */
  _parser?: (buf: Buffer) => Promise<{ text: string; numpages: number }>;
}

/** @internal */
export interface PdfParseResult {
  text: string;
  numpages: number;
}

/** Lazy-require the optional peer dep. Throws a clear error if not installed. */
function loadPdfParseModule(): (buf: Buffer) => Promise<PdfParseResult> {
  // Never branch on `typeof require`: esbuild injects an ESM `__require` shim that is a
  // function but cannot load native/CJS dependencies. createRequire is the real loader in both
  // formats; CJS uses __filename while ESM uses import.meta.url.
  const moduleLocation = typeof __filename === "string" ? __filename : import.meta.url;
  const req: NodeRequire = createRequire(moduleLocation);
  try {
    // pdf-parse exports itself as a function directly in CJS
    const mod = req("pdf-parse") as unknown;
    const fn = typeof mod === "function" ? mod : (mod as { default?: unknown }).default;
    if (typeof fn !== "function") {
      throw new Error("unexpected module shape");
    }
    return fn as (buf: Buffer) => Promise<PdfParseResult>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("unexpected module shape")) {
      throw new Error(
        "[eidentic/rag] loadPdf requires the `pdf-parse` package.\n" +
          "Install it in your project:\n" +
          "  npm install pdf-parse\n" +
          "  # or\n" +
          "  pnpm add pdf-parse",
      );
    }
    throw err;
  }
}

/**
 * Extract text from a PDF `Buffer`.
 *
 * `pdf-parse` is an **optional peer dependency** — install it separately:
 * ```sh
 * npm install pdf-parse
 * # or
 * pnpm add pdf-parse
 * ```
 *
 * @param buf  - PDF file contents as a `Buffer`.
 * @param opts - Optional configuration.
 * @returns Extracted text and metadata (`source`, `pages`).
 * @throws Error if `pdf-parse` is not installed and no `_parser` is provided.
 */
export async function loadPdf(
  buf: Buffer,
  opts?: PdfLoaderOptions,
): Promise<LoadedDocument> {
  const source = opts?.source ?? "pdf";
  const parse = opts?._parser ?? loadPdfParseModule();

  const result = await parse(buf);

  // Collapse excessive whitespace produced by PDF text extraction
  let text = result.text;
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return {
    text,
    metadata: { source, pages: result.numpages },
  };
}
