# @eidentic/better-auth

Better-auth session adapter for Eidentic — implements `AuthPort` by verifying sessions
through a `better-auth` instance and mapping them to Eidentic's `AuthPrincipal`. No
opinion on how you configure better-auth (DB, providers, plugins) — the adapter only
calls `auth.api.getSession()`.

## Install

```bash
pnpm add @eidentic/better-auth better-auth
```

## Usage

```ts
import { betterAuthPort } from "@eidentic/better-auth";
import { createServer } from "@eidentic/server";
import { auth } from "./lib/auth"; // your better-auth instance

const authPort = betterAuthPort(auth, {
  // Optional: derive extra principal fields from the session
  principalFrom: ({ session, user }) => ({
    orgId: session?.activeOrganizationId ?? undefined,
  }),
});

const app = createServer({
  agents: { support: myAgent },
  auth: authPort,
});
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
