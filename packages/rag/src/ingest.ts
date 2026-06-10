import type { MemoryEvent, Scope } from "@eidentic/types";
import { resilientFetch, assertFetchableUrl } from "@eidentic/tools";
import { chunkText, type ChunkOptions } from "./chunk.js";
import { loadMarkdown, loadHtml, loadPdf, type PdfLoaderOptions } from "./loaders.js";

/** A structural memory interface — any object with an `ingest` method works here. */
export interface IngestableMemory {
  ingest(events: MemoryEvent[]): Promise<void>;
}

/** A URL-based document source. */
export interface UrlSource {
  url: string;
}

/**
 * A typed document content source.
 *
 * Use this to pass pre-loaded document bytes/strings to `ingestDocument` so the
 * correct loader (Markdown stripper, HTML extractor, or PDF parser) is applied
 * before chunking.
 *
 * Example:
 * ```ts
 * await ingestDocument(
 *   { type: "html", data: "<html>…</html>", source: "https://example.com/page" },
 *   { memory, scope },
 * );
 * ```
 */
export type TypedContentSource =
  | { type: "markdown"; data: string; source?: string }
  | { type: "html"; data: string; source?: string }
  | { type: "pdf"; data: Buffer; source?: string; _parser?: PdfLoaderOptions["_parser"] };

/** Options for {@link ingestDocument}. */
export interface IngestDocumentOptions {
  /** The memory to ingest into. Accepts any object with `ingest(events)` — not tied to `@eidentic/memory`. */
  memory: IngestableMemory;
  /** The memory scope to attach events to. */
  scope: Scope;
  /**
   * Stable document identifier used to build chunk ids (`${docId}:chunk:${i}`).
   * Defaults to a slug derived from the source URL or a truncated hash of the text.
   */
  docId?: string;
  /** Chunking options forwarded to {@link chunkText}. */
  chunk?: ChunkOptions;
  /**
   * Fetch implementation override (useful in tests). Defaults to {@link resilientFetch}.
   *
   * **SSRF contract:** the provided implementation MUST respect the `redirect: "manual"`
   * option and return a 3xx response instead of silently following redirects.  If the
   * implementation auto-follows redirects (e.g. the default `globalThis.fetch` without
   * the `manual` option), the SSRF guard will detect this at runtime and throw, because
   * redirect chains must be validated hop-by-hop.  If you supply a custom fetch, ensure
   * it honours `{ redirect: "manual" }`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional egress allowlist of hostnames for URL-based ingestion (§5.6 / §10.3).
   *
   * - **Omitted (`undefined`):** no domain restriction — any public http(s) host is allowed
   *   (private/loopback/metadata hosts are still always blocked by the SSRF guard).
   * - **Empty array (`[]`):** denies ALL URL fetches (explicit lockdown).
   * - **Non-empty:** restricts URL fetches to the listed hosts and their subdomains.
   *
   * Has no effect when `source` is a plain string (no fetch occurs).
   */
  allowlist?: string[];
}

/**
 * A simple deterministic slug from a URL — lowercased hostname + first path segments,
 * special characters replaced with hyphens.
 */
function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = (u.hostname + u.pathname)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return parts.slice(0, 64) || "doc";
  } catch {
    return "doc";
  }
}

/**
 * A simple deterministic id from plain text — djb2 hash truncated to hex.
 */
function hashSlug(text: string): string {
  let h = 5381;
  for (let i = 0; i < Math.min(text.length, 2048); i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return `doc-${h.toString(16)}`;
}

/** Maximum number of redirect hops to follow before giving up (SSRF / loop protection). */
const MAX_REDIRECT_HOPS = 5;

/**
 * Normalise a URL string for comparison: remove trailing slashes and
 * canonicalise the scheme+host to lowercase.  Used to detect whether a
 * fetchImpl silently changed the effective URL (auto-followed redirect).
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Ingest a document into a memory store via chunking.
 *
 * @param source - The document source. Three overloads:
 *   - **`string`** — raw text, chunked directly. **No network fetch occurs.**
 *     If the string starts with `http://` or `https://` you probably meant
 *     `{ url: "..." }` instead — a warning will be emitted to `console.warn`.
 *   - **`{ url: string }`** — fetch the URL (public http(s) only; private/loopback
 *     /metadata addresses are always rejected by the SSRF guard) and treat the
 *     response body as plain text. All redirect hops are re-validated against the
 *     same SSRF guard before following; a maximum of {@link MAX_REDIRECT_HOPS} hops
 *     is enforced to prevent redirect loops.
 *   - **`TypedContentSource`** — a pre-loaded document with an explicit type:
 *       - `{ type: "markdown", data: string }` — strip MD syntax then chunk.
 *       - `{ type: "html", data: string }` — extract readable text then chunk.
 *       - `{ type: "pdf", data: Buffer }` — parse PDF via `pdf-parse` then chunk.
 *         `pdf-parse` must be installed separately (`npm install pdf-parse`).
 *
 * Returns `{ chunks: number }` — the number of chunks ingested.
 */
export async function ingestDocument(
  source: string | UrlSource | TypedContentSource,
  opts: IngestDocumentOptions,
): Promise<{ chunks: number }> {
  let rawText: string;
  let docId: string;
  let extraMeta: Record<string, unknown> = {};

  if (typeof source === "string") {
    // FIX 4: Warn when a plain string looks like a URL — likely a misuse of the API.
    // The string is still treated as raw text (existing behavior unchanged).
    if (source.startsWith("http://") || source.startsWith("https://")) {
      console.warn(
        `[ingestDocument] source looks like a URL but was passed as a plain string — it will be ` +
        `ingested as raw text, NOT fetched. If you meant to fetch this URL, use { url: "${source}" } instead.`,
      );
    }
    rawText = source;
    docId = opts.docId ?? hashSlug(rawText);
  } else if ("type" in source) {
    // TypedContentSource — run the appropriate loader
    const typedSource = source as TypedContentSource;
    let loaded: { text: string; metadata: Record<string, unknown> };

    if (typedSource.type === "markdown") {
      loaded = loadMarkdown(typedSource.data, { source: typedSource.source });
    } else if (typedSource.type === "html") {
      loaded = loadHtml(typedSource.data, { source: typedSource.source });
    } else {
      // pdf
      loaded = await loadPdf(typedSource.data, {
        source: typedSource.source,
        _parser: typedSource._parser,
      });
    }

    rawText = loaded.text;
    extraMeta = loaded.metadata;
    docId = opts.docId ?? hashSlug(rawText);
  } else {
    // SSRF guard: validate before any network I/O.
    // Throws if URL is non-http(s), private, loopback, link-local, or metadata range,
    // or if an allowlist is provided and the host is not on it.
    assertFetchableUrl(source.url, { allowlist: opts.allowlist });

    // FIX 1: Follow redirect chains with per-hop SSRF re-validation.
    //
    // Mirror the web_fetch hardening pattern: issue every hop with redirect:"manual"
    // so the platform never silently follows a redirect to a private/metadata host.
    // Each Location header is parsed and re-validated via assertFetchableUrl before
    // the next request is issued. A hard cap of MAX_REDIRECT_HOPS prevents infinite
    // redirect loops (circular redirect / DoS mitigation).
    const doFetch: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
    let currentUrl = source.url;
    let hops = 0;
    let finalRes: Response;

    while (true) {
      const res = await resilientFetch(currentUrl, { redirect: "manual" }, { fetchImpl: doFetch });

      // Runtime assertion: verify the fetchImpl honours redirect:"manual".
      // If the implementation silently auto-followed a redirect, `res.redirected`
      // will be true — meaning the SSRF hop-by-hop guard was bypassed.
      // We also check res.url when it is explicitly set to a different URL
      // (non-empty, differs from the requested URL) on a 2xx response, which
      // is another indicator that auto-following occurred.
      const autoFollowed =
        res.redirected === true ||
        (
          res.status < 300 &&
          typeof res.url === "string" &&
          res.url !== "" &&
          normalizeUrl(res.url) !== normalizeUrl(currentUrl)
        );
      if (autoFollowed) {
        throw new Error(
          "ingestDocument: the supplied fetchImpl auto-followed a redirect instead of " +
          "honouring redirect:\"manual\". Replace it with a fetch implementation that " +
          "returns 3xx responses rather than following them, so every redirect hop can " +
          "be re-validated by the SSRF guard.",
        );
      }

      if (res.status >= 300 && res.status < 400) {
        hops++;
        if (hops > MAX_REDIRECT_HOPS) {
          throw new Error(
            `ingestDocument: too many redirects (> ${MAX_REDIRECT_HOPS} hops) starting from ${source.url}`,
          );
        }
        const location = res.headers.get("location");
        if (location === null) {
          throw new Error(`ingestDocument: redirect has no Location header (hop ${hops})`);
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error(`ingestDocument: invalid redirect target at hop ${hops} (URL omitted for security)`);
        }
        // Re-validate each hop — a public→public→internal chain must be rejected at hop 2+.
        assertFetchableUrl(nextUrl.toString(), { allowlist: opts.allowlist });
        currentUrl = nextUrl.toString();
      } else {
        finalRes = res;
        break;
      }
    }

    if (!finalRes.ok) {
      throw new Error(`ingestDocument: failed to fetch ${source.url} — HTTP ${finalRes.status}`);
    }
    rawText = await finalRes.text();
    docId = opts.docId ?? slugFromUrl(source.url);
  }

  const chunks = chunkText(rawText, opts.chunk);
  if (chunks.length === 0) return { chunks: 0 };

  // Determine citation source:
  //   - plain string → docId
  //   - URL source   → the fetched URL
  //   - typed source → the `source` field from the loader metadata (set by the loader from
  //                    the TypedContentSource.source option, or loader default if unset)
  let citationSource: string;
  if (typeof source === "string") {
    citationSource = docId;
  } else if ("type" in source) {
    // TypedContentSource: use loader-provided metadata.source (already set by the loader)
    citationSource = (extraMeta.source as string | undefined) ?? docId;
  } else {
    citationSource = (source as UrlSource).url;
  }

  const events: MemoryEvent[] = chunks.map((chunk, i) => ({
    id: `${docId}:chunk:${i}`,
    scope: opts.scope,
    text: chunk.text,
    // Merge loader-provided metadata (source, pages, etc.) into chunk metadata.
    metadata: { ...extraMeta, source: citationSource },
  }));

  await opts.memory.ingest(events);
  return { chunks: chunks.length };
}
