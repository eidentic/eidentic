import type { AuthPort, AuthPrincipal, AuthRequest } from "@eidentic/types";

export type { AuthPort, AuthPrincipal, AuthRequest };

/**
 * Structural view of the better-auth server API we call.
 *
 * better-auth 1.6.x exposes `auth.api.getSession({ headers })` returning
 * `{ session, user } | null`. We only depend on the fields we actually map,
 * so any better-auth instance (or a hand-rolled fake) that satisfies this
 * interface is accepted — no real DB/provider wiring required.
 *
 * The caller is responsible for configuring better-auth themselves (DB,
 * providers, plugins, schema). This adapter only verifies sessions.
 */
export interface BetterAuthLike {
  getSession(args: { headers: Headers }): Promise<{
    session?: { activeOrganizationId?: string | null } | null;
    user?: { id: string } | null;
  } | null>;
}

export interface BetterAuthPortOptions {
  /**
   * Map the better-auth session/user to extra AuthPrincipal fields.
   * The result is shallow-merged on top of the base principal, so you can
   * override or supplement any field (e.g. derive orgId from a custom claim).
   *
   * @example
   * ```ts
   * principalFrom: ({ session }) => ({ orgId: session?.customOrgClaim ?? undefined })
   * ```
   */
  principalFrom?: (s: {
    user?: { id: string } | null;
    session?: { activeOrganizationId?: string | null } | null;
  }) => Partial<AuthPrincipal>;
}

/**
 * Adapt a better-auth instance's `api` (or any `BetterAuthLike`) into a
 * Eidentic `AuthPort`.
 *
 * Usage with better-auth's own server instance:
 * ```ts
 * import { auth } from "./auth"; // your better-auth instance
 * import { betterAuthPort } from "@eidentic/better-auth";
 * import { createServer } from "@eidentic/server";
 *
 * const app = createServer({ agents, auth: betterAuthPort(auth) });
 * ```
 *
 * The user must configure better-auth themselves (DB, providers, schema).
 * This adapter only verifies sessions and maps them to `AuthPrincipal`.
 * Works with `@eidentic/server` and `@eidentic/studio` `auth` option.
 *
 * Fail-closed: if `getSession` throws for any reason, `authenticate` returns
 * `null` (→ 401), never propagating the error to the server layer.
 */
export function betterAuthPort(
  auth: { api: BetterAuthLike } | BetterAuthLike,
  opts?: BetterAuthPortOptions,
): AuthPort {
  // Resolve whether we got `{ api: BetterAuthLike }` or a bare `BetterAuthLike`.
  const api: BetterAuthLike =
    "api" in auth && typeof (auth as { api: BetterAuthLike }).api === "object" &&
    typeof (auth as { api: BetterAuthLike }).api.getSession === "function"
      ? (auth as { api: BetterAuthLike }).api
      : (auth as BetterAuthLike);

  return {
    async authenticate(req: AuthRequest): Promise<AuthPrincipal | null> {
      // 1. Rebuild a Headers object from the AuthRequest header record.
      //    @eidentic/server lowercases all keys before calling authenticate,
      //    so the Headers object will have lowercase names — matching what
      //    better-auth expects (it reads cookie/authorization etc case-insensitively).
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }

      // 2. Call better-auth's getSession. Fail-closed on any error.
      let result: Awaited<ReturnType<BetterAuthLike["getSession"]>>;
      try {
        result = await api.getSession({ headers });
      } catch {
        // Fail-closed: network/DB errors → 401, never 500.
        return null;
      }

      // 3. No session or no user → 401.
      if (!result || !result.user?.id) {
        return null;
      }

      const { user, session } = result;

      // 4. Map to AuthPrincipal.
      const base: AuthPrincipal = {
        userId: user.id,
        orgId: session?.activeOrganizationId ?? undefined,
      };

      // 5. Merge optional principalFrom override.
      const extra = opts?.principalFrom?.({ user, session }) ?? {};
      return { ...base, ...extra };
    },
  };
}
