import { describe, expect, it } from "vitest";
import {
  assertSafeEgressUrl as guardedAssertSafeEgressUrl,
  createSafeEgressPort,
  isBlockedHost,
  safeFetch as guardedSafeFetch,
  safeFetchText as guardedSafeFetchText,
} from "../src/index.js";

const PUBLIC_IP = "93.184.216.34";

// Existing focused cases exercise DNS/redirect/body behavior with an explicit legacy public-host
// opt-in. Dedicated cases below verify that the production default denies an omitted allowlist.
const assertSafeEgressUrl: typeof guardedAssertSafeEgressUrl = (raw, policy = {}) =>
  guardedAssertSafeEgressUrl(raw, { unsafeAllowAnyPublicHost: true, ...policy });
const safeFetch: typeof guardedSafeFetch = (raw, init, options = {}) =>
  guardedSafeFetch(raw, init, { unsafeAllowAnyPublicHost: true, ...options });
const safeFetchText: typeof guardedSafeFetchText = (raw, init, options = {}) =>
  guardedSafeFetchText(raw, init, { unsafeAllowAnyPublicHost: true, ...options });

describe("safe egress policy", () => {
  it("denies omitted host allowlists and cleartext HTTP by default", async () => {
    await expect(guardedAssertSafeEgressUrl("https://example.com/x", {
      resolveHost: async () => [PUBLIC_IP],
    })).rejects.toThrow(/allowlist/i);
    await expect(guardedAssertSafeEgressUrl("http://example.com/x", {
      allowlist: ["example.com"],
      resolveHost: async () => [PUBLIC_IP],
    })).rejects.toThrow(/HTTPS/i);
  });
  it("adapts the hardened fetch path to the framework SafeEgressPort contract", async () => {
    let calls = 0;
    const port = createSafeEgressPort({
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async (_url, init) => {
        calls++;
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        return new Response(null, { status: 204 });
      },
    });
    await expect(port.validate("https://example.com/hook", { allowedHosts: [], requireHttps: true }))
      .rejects.toThrow(/allowlist/i);
    await port.validate("https://example.com/hook", { allowedHosts: ["example.com"], requireHttps: true });
    const response = await port.request({
      url: "https://example.com/hook",
      method: "POST",
      body: "{}",
      policy: { allowedHosts: ["example.com"], requireHttps: true },
    });
    expect(response).toEqual({ status: 204, safeUrl: "https://example.com/hook" });
    expect(calls).toBe(1);
  });

  it("rejects URL credentials before making a request", async () => {
    await expect(
      assertSafeEgressUrl("https://user:secret@example.com/private", {
        resolveHost: async () => [PUBLIC_IP],
      }),
    ).rejects.toThrow(/credentials/i);
  });

  it("fails closed when any A/AAAA result is non-global", async () => {
    await expect(
      assertSafeEgressUrl("https://public.example/resource", {
        resolveHost: async () => [PUBLIC_IP, "127.0.0.1", "2001:4860:4860::8888"],
      }),
    ).rejects.toThrow(/non-global|blocked/i);
  });

  it("fails closed when DNS returns no addresses", async () => {
    await expect(
      assertSafeEgressUrl("https://public.example/resource", {
        resolveHost: async () => [],
      }),
    ).rejects.toThrow(/no addresses/i);
  });

  it("classifies reserved and special-use IP ranges as blocked", () => {
    for (const address of [
      "100.64.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "2001:db8::1",
      "4000::1",
      "ff02::1",
    ]) {
      expect(isBlockedHost(address), address).toBe(true);
    }
  });

  it("revalidates DNS on every retry and redirect hop", async () => {
    const resolved: string[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls++;
      if (calls === 1) return new Response("retry", { status: 503 });
      if (url.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        });
      }
      return new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const result = await safeFetchText("https://origin.example/start", undefined, {
      fetchImpl,
      retries: 1,
      resolveHost: async (hostname) => {
        resolved.push(hostname);
        return [PUBLIC_IP];
      },
      maxResponseBytes: 1024,
    });

    expect(result.content).toBe("done");
    expect(resolved).toEqual([
      "origin.example",
      "origin.example",
      "cdn.example",
    ]);
  });

  it.each(["POST", "post", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects retries for non-GET/HEAD method %s before network I/O",
    async (method) => {
      let calls = 0;
      await expect(safeFetch("https://example.com/action", {
        method,
        body: "payload",
      }, {
        fetchImpl: async () => { calls++; return new Response("never"); },
        resolveHost: async () => [PUBLIC_IP],
        retries: 1,
      })).rejects.toThrow(/retry|GET|HEAD/i);
      expect(calls).toBe(0);
    },
  );

  it.each(["GET", "HEAD"])("allows configured retries for %s", async (method) => {
    let calls = 0;
    const result = await safeFetch("https://example.com/retry", { method }, {
      fetchImpl: (async () => {
        calls++;
        return new Response(null, { status: calls === 1 ? 503 : 204 });
      }) as typeof fetch,
      resolveHost: async () => [PUBLIC_IP],
      retries: 1,
    });
    expect(result.response.status).toBe(204);
    expect(calls).toBe(2);
  });

  it("drops all caller headers and ambient credentials on a cross-origin redirect", async () => {
    const attempts: Array<{
      url: string;
      headers: Headers;
      credentials?: RequestCredentials;
      referrer?: string;
      referrerPolicy?: ReferrerPolicy;
    }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      attempts.push({
        url,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
        referrer: init?.referrer,
        referrerPolicy: init?.referrerPolicy,
      });
      if (url.includes("origin.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        });
      }
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    await safeFetchText("https://origin.example/start", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-custom-secret": "secret",
      },
      credentials: "include",
      referrer: "https://origin.example/private?token=secret",
    }, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
    });

    expect(attempts).toHaveLength(2);
    expect([...attempts[0]!.headers.keys()]).toContain("authorization");
    expect([...attempts[1]!.headers.keys()]).toEqual([]);
    expect(attempts[1]!.credentials).toBe("omit");
    expect(attempts[1]!.referrer).toBeUndefined();
    expect(attempts[1]!.referrerPolicy).toBe("no-referrer");
  });

  it("rejects an auto-followed response URL even when the final status is non-success", async () => {
    const fetchImpl = (async () => {
      const response = new Response("not found", { status: 404 });
      Object.defineProperty(response, "url", { value: "https://other.example/final" });
      Object.defineProperty(response, "redirected", { value: false });
      return response;
    }) as typeof fetch;

    await expect(safeFetch("https://example.com/start", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
    })).rejects.toThrow(/auto-followed|manual/i);
  });

  it("retains caller headers on a same-origin redirect", async () => {
    const seenAuthorization: Array<string | null> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenAuthorization.push(new Headers(init?.headers).get("authorization"));
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("ok", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    await safeFetchText("https://example.com/start", {
      headers: { authorization: "Bearer same-origin" },
    }, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
    });
    expect(seenAuthorization).toEqual(["Bearer same-origin", "Bearer same-origin"]);
  });

  it("enforces maxRedirects exactly and cancels every abandoned redirect body", async () => {
    let calls = 0;
    let cancellations = 0;
    const fetchImpl = (async () => {
      calls++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("redirect")); },
        cancel() { cancellations++; },
      });
      return new Response(body, {
        status: 302,
        headers: { location: `https://example.com/hop-${calls}` },
      });
    }) as typeof fetch;

    await expect(safeFetch("https://example.com/start", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
      maxRedirects: 1,
    })).rejects.toThrow(/redirect limit/i);
    expect(calls).toBe(2);
    expect(cancellations).toBe(2);
  });

  it("rejects a response that exceeds the configured byte limit", async () => {
    const fetchImpl = (async () =>
      new Response("x".repeat(2048), {
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    await expect(
      safeFetchText("https://example.com/large", undefined, {
        fetchImpl,
        resolveHost: async () => [PUBLIC_IP],
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow(/response body.*1024|exceeds.*1024/i);
  });

  it("enforces the streamed byte cap even when Content-Length understates the body", async () => {
    let cancelled = false;
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
      },
      cancel() { cancelled = true; },
    }), {
      headers: { "content-type": "text/plain", "content-length": "10" },
    })) as typeof fetch;

    await expect(safeFetchText("https://example.com/stream", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
      maxResponseBytes: 1024,
    })).rejects.toThrow(/exceeds 1024/i);
    expect(cancelled).toBe(true);
  });

  it("accepts a multi-chunk response exactly at the byte cap", async () => {
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512).fill(97));
        controller.enqueue(new Uint8Array(512).fill(98));
        controller.close();
      },
    }), { headers: { "content-type": "text/plain" } })) as typeof fetch;
    const result = await safeFetchText("https://example.com/exact", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
      maxResponseBytes: 1024,
    });
    expect(Buffer.byteLength(result.content)).toBe(1024);
    expect(result.truncated).toBe(false);
  });

  it("rejects binary response media types", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { "content-type": "application/octet-stream" },
      })) as typeof fetch;

    await expect(
      safeFetchText("https://example.com/file", undefined, {
        fetchImpl,
        resolveHost: async () => [PUBLIC_IP],
        allowedContentTypes: ["text/", "application/json"],
      }),
    ).rejects.toThrow(/content type/i);
  });

  it("does not let stalled response cancellation hide a media-type rejection", async () => {
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([0, 1, 2])); },
      cancel: () => new Promise<void>(() => { /* stalled transport cleanup */ }),
    }), { headers: { "content-type": "application/octet-stream" } })) as typeof fetch;

    await expect(safeFetchText("https://example.com/file", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
      allowedContentTypes: ["text/"],
    })).rejects.toThrow(/content type/i);
  }, 250);

  it("times out while consuming a stalled response body", async () => {
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start() { /* intentionally never emits or closes */ },
    }), { headers: { "content-type": "text/plain" } })) as typeof fetch;

    await expect(
      safeFetchText("https://example.com/stalled", undefined, {
        fetchImpl,
        resolveHost: async () => [PUBLIC_IP],
        bodyTimeoutMs: 10,
      }),
    ).rejects.toThrow(/body timed out/i);
  });

  it("applies the request timeout while DNS preflight is stalled", async () => {
    await expect(
      safeFetchText("https://example.com/stalled-dns", undefined, {
        fetchImpl: async () => new Response("must not run"),
        resolveHost: () => new Promise<string[]>(() => { /* stalled resolver */ }),
        timeoutMs: 10,
        retries: 0,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 250);

  it("does not misclassify HTTP 304 as a redirect", async () => {
    const result = await safeFetchText("https://example.com/cache", undefined, {
      fetchImpl: async () => new Response(null, { status: 304 }),
      resolveHost: async () => [PUBLIC_IP],
    });
    expect(result.status).toBe(304);
    expect(result.content).toBe("");
  });

  it("ignores URL fragments when checking a fetch implementation's effective URL", async () => {
    const fetchImpl = (async () => {
      const response = new Response("ok", { headers: { "content-type": "text/plain" } });
      Object.defineProperty(response, "url", { value: "https://example.com/path" });
      return response;
    }) as typeof fetch;
    const result = await safeFetchText("https://example.com/path#client-only", undefined, {
      fetchImpl,
      resolveHost: async () => [PUBLIC_IP],
    });
    expect(result.content).toBe("ok");
  });
});
