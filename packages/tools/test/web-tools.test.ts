import { describe, it, expect } from "vitest";
import type { ToolContext } from "@eidentic/core";
import { MapSecrets } from "@eidentic/types/testing";
import { webTools, hostAllowed, isBlockedHost, safeUrlForError } from "../src/index.js";

/** Minimal fake fetch returning a fixed text body. */
function fakeFetch(body: string, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(body, { status, headers })) as unknown as typeof fetch;
}

const byId = (tools: ReturnType<typeof webTools>, id: string) => {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe("webTools — sealed web_fetch + egress allowlist (§5.6)", () => {
  it("hostAllowed: exact + dot-boundary suffix; empty list denies all", () => {
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("api.example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("notexample.com", ["example.com"])).toBe(false);
    expect(hostAllowed("example.com", [])).toBe(false);
  });

  it("fetches an allowlisted URL and returns its text", async () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("PAGE BODY") });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://example.com/x" })) as { content: string; status: number };
    expect(out.content).toBe("PAGE BODY");
    expect(out.status).toBe(200);
  });

  it("rejects a non-allowlisted host", async () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("nope") });
    await expect(byId(tools, "web_fetch").execute({ url: "https://evil.test/x" })).rejects.toThrow(/allowlist/);
  });

  it("empty allowlist denies ALL fetches (explicit lockdown)", async () => {
    const tools = webTools({ allowlist: [], fetchImpl: fakeFetch("nope") });
    await expect(byId(tools, "web_fetch").execute({ url: "https://example.com/x" })).rejects.toThrow(/allowlist/);
  });

  it("omitted allowlist applies NO domain restriction (fetches any public host)", async () => {
    const tools = webTools({ fetchImpl: fakeFetch("PUBLIC BODY") });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://anything.example.org/x" })) as { content: string; status: number };
    expect(out.content).toBe("PUBLIC BODY");
    expect(out.status).toBe(200);
  });

  it("omitted allowlist STILL rejects private/loopback/metadata hosts (SSRF guard)", async () => {
    const tools = webTools({ fetchImpl: fakeFetch("SHOULD NOT REACH") });
    await expect(byId(tools, "web_fetch").execute({ url: "http://localhost/x" })).rejects.toThrow(/private|loopback|blocked/i);
    await expect(byId(tools, "web_fetch").execute({ url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(/private|loopback|blocked/i);
  });

  it("rejects non-http(s) schemes", async () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("x") });
    await expect(byId(tools, "web_fetch").execute({ url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    await expect(byId(tools, "web_fetch").execute({ url: "ftp://example.com/x" })).rejects.toThrow(/http/);
  });

  it("rejects a redirect that points off the allowlist", async () => {
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: fakeFetch("", 302, { location: "https://evil.test/" }),
    });
    await expect(byId(tools, "web_fetch").execute({ url: "https://example.com/r" })).rejects.toThrow(/redirect off egress/);
  });

  it("allows a subdomain (dot-suffix) but rejects a look-alike host", async () => {
    expect(hostAllowed("api.example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("notexample.com", ["example.com"])).toBe(false);
    // Also test fetching via subdomain
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("SUB") });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://api.example.com/v1" })) as { content: string };
    expect(out.content).toBe("SUB");
  });

  it("web_fetch is read-only", () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("x") });
    expect(byId(tools, "web_fetch").sideEffect).toBe("read-only");
  });

  it("web_search is present by default even without a provider (returns unconfigured message)", async () => {
    // Pass an explicit empty env so env auto-detect yields null regardless of CI environment.
    // We cannot inject env into webTools directly — the env check happens lazily per call.
    // Here we call with no search options; the tool self-describes when unconfigured.
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("x"), webSearch: true });
    expect(tools.find((t) => t.id === "web_search")).toBeDefined();
  });

  it("web_search is omitted when webSearch: false", () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("x"), webSearch: false });
    expect(tools.find((t) => t.id === "web_search")).toBeUndefined();
  });

  it("web_search uses the provider and the provider reads its key from ctx.secrets (never the model)", async () => {
    let seenKey: string | undefined;
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: fakeFetch("x"),
      search: async (query, ctx) => {
        seenKey = await ctx?.secrets?.get("SEARCH_API_KEY");
        return [{ title: `r:${query}`, url: "https://example.com", snippet: "s" }];
      },
    });
    const ctx: ToolContext = { secrets: new MapSecrets({ SEARCH_API_KEY: "sk-test" }) };
    const out = (await byId(tools, "web_search").execute({ query: "eidentic" }, ctx)) as { results: Array<{ title: string }> };
    expect(seenKey).toBe("sk-test");
    expect(out.results[0]!.title).toBe("r:eidentic");
    // The input schema has only `query` — the model cannot pass an API key.
    const schema = JSON.stringify(byId(tools, "web_search").jsonSchema);
    expect(schema).not.toMatch(/key/i);
  });

  it("truncates large responses and flags truncation", async () => {
    const big = "x".repeat(600 * 1024); // 600 KB > 512 KB cap
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch(big) });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://example.com/" })) as { content: string; truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(big.length);
  });
});

describe("webTools — SSRF private-IP guard (isBlockedHost)", () => {
  it("isBlockedHost detects loopback and private IPs", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("127.100.200.1")).toBe(true);
    expect(isBlockedHost("0.0.0.0")).toBe(true);
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.255.255")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.0.1")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true); // cloud metadata
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("[::1]")).toBe(true);
    expect(isBlockedHost("fc00::1")).toBe(true);
    expect(isBlockedHost("fd12:3456::1")).toBe(true);
  });

  it("isBlockedHost blocks IPv6-mapped/compatible IPv4 (SSRF bypass)", () => {
    // dotted IPv4-mapped form
    expect(isBlockedHost("::ffff:169.254.169.254")).toBe(true); // cloud metadata via v6-mapped
    expect(isBlockedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isBlockedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedHost("::ffff:10.0.0.1")).toBe(true);
    // hex IPv4-mapped form (a9fe:a9fe == 169.254.169.254)
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true);
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    // IPv4-compatible (deprecated) form
    expect(isBlockedHost("::127.0.0.1")).toBe(true);
    // but a mapped PUBLIC IPv4 is allowed
    expect(isBlockedHost("::ffff:8.8.8.8")).toBe(false);
  });

  it("isBlockedHost blocks IPv6 unspecified and link-local", () => {
    expect(isBlockedHost("::")).toBe(true);                 // unspecified (== 0.0.0.0)
    expect(isBlockedHost("fe80::1")).toBe(true);            // link-local
    expect(isBlockedHost("fe80::1%eth0")).toBe(true);       // link-local with zone id
    expect(isBlockedHost("[fe80::abcd]")).toBe(true);
    expect(isBlockedHost("2001:4860:4860::8888")).toBe(false); // public IPv6 (Google DNS) allowed
  });

  it("isBlockedHost permits public IPs", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("1.1.1.1")).toBe(false);
    expect(isBlockedHost("93.184.216.34")).toBe(false); // example.com
    expect(isBlockedHost("172.15.0.1")).toBe(false); // just below 172.16
    expect(isBlockedHost("172.32.0.1")).toBe(false); // just above 172.31
    expect(isBlockedHost("192.169.0.1")).toBe(false);
    expect(isBlockedHost("11.0.0.1")).toBe(false);
  });

  it("web_fetch rejects 127.0.0.1 even when allowlisted", async () => {
    // Allowlist the IP literally (unusual but possible attempt to bypass)
    const tools = webTools({ allowlist: ["127.0.0.1"], fetchImpl: fakeFetch("secret") });
    await expect(byId(tools, "web_fetch").execute({ url: "http://127.0.0.1/" }))
      .rejects.toThrow(/blocked private\/loopback/);
  });

  it("web_fetch rejects 169.254.169.254 (cloud metadata) even when allowlisted", async () => {
    const tools = webTools({ allowlist: ["169.254.169.254"], fetchImpl: fakeFetch("credentials") });
    await expect(byId(tools, "web_fetch").execute({ url: "http://169.254.169.254/" }))
      .rejects.toThrow(/blocked private\/loopback/);
  });

  it("web_fetch rejects 10.1.2.3 (RFC-1918) even when allowlisted", async () => {
    const tools = webTools({ allowlist: ["10.1.2.3"], fetchImpl: fakeFetch("internal") });
    await expect(byId(tools, "web_fetch").execute({ url: "http://10.1.2.3/" }))
      .rejects.toThrow(/blocked private\/loopback/);
  });

  it("web_fetch still allows a normal public allowlisted host", async () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch("OK") });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://example.com/" })) as { content: string };
    expect(out.content).toBe("OK");
  });

  it("isBlockedHost blocks non-dotted decimal IPv4 encodings (defense-in-depth)", () => {
    // 2130706433 = 0x7f000001 = 127.0.0.1 (loopback)
    expect(isBlockedHost("2130706433")).toBe(true);
    // 3232235777 = 0xC0A80101 = 192.168.1.1 (private)
    expect(isBlockedHost("3232235777")).toBe(true);
    // 167772161 = 0x0A000001 = 10.0.0.1 (private)
    expect(isBlockedHost("167772161")).toBe(true);
    // 2886729729 = 0xAC100001 = 172.16.0.1 (private)
    expect(isBlockedHost("2886729729")).toBe(true);
    // 2852039166 = 0xAA9EA9FE = 169.254.169.254 (cloud metadata)
    expect(isBlockedHost("2852039166")).toBe(true);
  });

  it("isBlockedHost blocks hex-encoded IPv4 loopback", () => {
    // 0x7f000001 = 127.0.0.1
    expect(isBlockedHost("0x7f000001")).toBe(true);
    // 0xc0a80101 = 192.168.1.1
    expect(isBlockedHost("0xc0a80101")).toBe(true);
  });

  it("isBlockedHost does NOT block large public-range integers", () => {
    // 134744072 = 0x08080808 = 8.8.8.8 (Google DNS — public)
    expect(isBlockedHost("134744072")).toBe(false);
  });

  it("web_fetch rejects non-dotted loopback decimal encoding", async () => {
    // 2130706433 = 127.0.0.1 encoded as a decimal integer.
    // Node's URL parser resolves this to 127.0.0.1; the request is rejected either by the
    // allowlist check (hostname normalized to 127.0.0.1, not matching "2130706433") or by
    // isBlockedHost. Either way, the URL must not be fetched.
    const tools = webTools({ allowlist: ["2130706433"], fetchImpl: fakeFetch("secret") });
    await expect(byId(tools, "web_fetch").execute({ url: "http://2130706433/" }))
      .rejects.toThrow(/blocked private\/loopback|not allowed|allowlist/);
  });
});

// ─── H7: Content-Length oversize path must not cancel-then-read ──────────────

describe("H7 — Content-Length > cap: no cancel-then-read contradiction", () => {
  /**
   * Build a fake fetch that returns a Response whose body is backed by a real ReadableStream
   * and whose Content-Length header advertises more bytes than MAX_FETCH_BYTES (512 KiB).
   * Before the fix, toResult() cancelled the body and then called getReader() on the cancelled
   * stream, producing a TypeError. After the fix it falls through to the streaming read which
   * caps at MAX_FETCH_BYTES and sets truncated:true.
   */
  function fakeStreamFetch(body: string, contentLength: number): typeof fetch {
    return (async () => {
      const encoder = new TextEncoder();
      const encoded = encoder.encode(body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-length": String(contentLength), "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;
  }

  it("does not throw when Content-Length > cap; returns truncated result", async () => {
    // body that fits in memory but Content-Length claims it is oversized
    const body = "A".repeat(600 * 1024); // 600 KB of actual data
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: fakeStreamFetch(body, 700 * 1024), // Content-Length claims 700 KB
    });

    let result: { content: string; truncated: boolean; url: string } | undefined;
    // Must NOT throw — the prior bug caused a TypeError here.
    await expect(
      byId(tools, "web_fetch").execute({ url: "https://example.com/big" }).then((r) => {
        result = r as { content: string; truncated: boolean; url: string };
      }),
    ).resolves.not.toThrow();

    expect(result).toBeDefined();
    expect(result!.truncated).toBe(true);
    expect(result!.content.length).toBeLessThanOrEqual(512 * 1024);
  });

  it("Content-Length within cap: body is read fully and truncated is false", async () => {
    const body = "hello world";
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: fakeStreamFetch(body, body.length),
    });
    const out = (await byId(tools, "web_fetch").execute({ url: "https://example.com/small" })) as {
      content: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(false);
    expect(out.content).toBe("hello world");
  });
});

// ─── M4: success result url field must strip query+fragment ──────────────────

describe("M4 — web_fetch success result strips query string and fragment from url", () => {
  it("url field in success result has query string stripped", async () => {
    const tools = webTools({
      fetchImpl: fakeFetch("PAGE CONTENT"),
    });
    const out = (await byId(tools, "web_fetch").execute({
      url: "https://example.com/path?token=sk-secret&foo=bar",
    })) as { url: string; content: string };
    expect(out.url).toBe("https://example.com/path");
    expect(out.url).not.toContain("sk-secret");
    expect(out.url).not.toContain("token=");
  });

  it("url field in success result has fragment stripped", async () => {
    const tools = webTools({
      fetchImpl: fakeFetch("CONTENT"),
    });
    const out = (await byId(tools, "web_fetch").execute({
      url: "https://example.com/page#sensitive-anchor",
    })) as { url: string };
    expect(out.url).toBe("https://example.com/page");
    expect(out.url).not.toContain("sensitive-anchor");
  });

  it("url field strips both query and fragment together", async () => {
    const tools = webTools({
      fetchImpl: fakeFetch("CONTENT"),
    });
    const out = (await byId(tools, "web_fetch").execute({
      url: "https://api.example.com/v1/data?api_key=abc123#results",
    })) as { url: string };
    expect(out.url).toBe("https://api.example.com/v1/data");
    expect(out.url).not.toContain("api_key");
    expect(out.url).not.toContain("results");
  });
});

// ─── A10: safeUrlForError — strips query string + fragment from error messages ──

describe("A10 — safeUrlForError strips credentials from error messages", () => {
  it("returns protocol + host + path, stripping query string", () => {
    const result = safeUrlForError("https://example.com/path?api_key=sk-secret&foo=bar");
    expect(result).toBe("https://example.com/path");
    expect(result).not.toContain("sk-secret");
    expect(result).not.toContain("api_key");
  });

  it("returns protocol + host + path, stripping fragment", () => {
    const result = safeUrlForError("https://example.com/page#sensitive");
    expect(result).toBe("https://example.com/page");
    expect(result).not.toContain("sensitive");
  });

  it("strips both query string and fragment together", () => {
    const result = safeUrlForError("https://example.com/resource?token=abc#section");
    expect(result).toBe("https://example.com/resource");
    expect(result).not.toContain("token");
  });

  it("handles a URL object input", () => {
    const url = new URL("https://api.example.com/v1/endpoint?auth=Bearer+xyz");
    const result = safeUrlForError(url);
    expect(result).toBe("https://api.example.com/v1/endpoint");
    expect(result).not.toContain("xyz");
  });

  it("returns [invalid URL] for a malformed string", () => {
    const result = safeUrlForError("not-a-valid-url-at-all!!!");
    expect(result).toBe("[invalid URL]");
  });

  it("web_fetch error for a non-allowlisted host does NOT reveal query-string secrets", async () => {
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: fakeFetch("nope"),
    });
    // Pass a secret in the query string — the error must NOT reproduce it.
    const url = "https://evil.test/endpoint?token=sk-supersecret";
    let errorMsg = "";
    try {
      await byId(tools, "web_fetch").execute({ url });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    expect(errorMsg.length).toBeGreaterThan(0);
    expect(errorMsg).not.toContain("sk-supersecret");
    expect(errorMsg).not.toContain("token=");
  });
});
