import { EVENT_SCHEMA_VERSION, StoreConflictError, upcastEvents, type EventKind, type StoredEvent, type StorePort, type Upcaster, type Usage } from "@eidentic/types";

export interface SessionDeps {
  sessionId: string;
  agentId: string;
  now: () => string; // injected clock
  newId: () => string; // injected id generator
  /** Optional upcaster registry — applied to events loaded from the store (§19.1). */
  upcasters?: Record<number, Upcaster>;
  /** Fix 1: owner identity recorded into SessionRecord on creation for multi-tenant ownership. */
  userId?: string;
  /** Fix 1: org identity recorded into SessionRecord on creation for multi-tenant ownership. */
  orgId?: string;
  /** H1 fix: API key recorded into SessionRecord so apiKey-only principals own their sessions. */
  apiKey?: string;
}

type SessionOwner = { userId?: string; orgId?: string; apiKey?: string };

/**
 * Match a caller to the canonical owner recorded on a session.
 *
 * Ownership uses the most specific recorded identifier. A user-owned session
 * cannot be opened merely because the caller belongs to the same organisation;
 * org ownership is consulted only when no user owner was recorded. API-key
 * ownership is the legacy fallback when neither user nor org identity exists.
 */
export function matchesSessionOwner(owner: SessionOwner, caller: SessionOwner): boolean {
  if (owner.userId !== undefined) return caller.userId === owner.userId;
  if (owner.orgId !== undefined) return caller.orgId === owner.orgId;
  if (owner.apiKey !== undefined) return caller.apiKey === owner.apiKey;
  return true;
}

export class Session {
  private constructor(
    private readonly store: StorePort,
    private readonly deps: SessionDeps,
    private _seq: number,
    private _cache: StoredEvent[],
  ) {}

  static async open(store: StorePort, deps: SessionDeps): Promise<Session> {
    let session = await store.getSession(deps.sessionId);
    if (!session) {
      session = {
        id: deps.sessionId,
        agentId: deps.agentId,
        createdAt: deps.now(),
        ...(deps.userId !== undefined ? { userId: deps.userId } : {}),
        ...(deps.orgId !== undefined ? { orgId: deps.orgId } : {}),
        ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}),
      };
      await store.createSession(session);
    } else if (session.agentId !== deps.agentId) {
      throw new StoreConflictError(
        `session ${deps.sessionId} belongs to a different agent (owner: ${session.agentId}, requester: ${deps.agentId})`,
      );
    } else {
      // Defense-in-depth for Finding #1 (IDOR): if the stored session has an owner identity,
      // the caller MUST provide the matching canonical identity. Identity omission is not a
      // trusted bypass: it would let any caller with a guessed session id replay another user.
      // This covers core/nextjs/A2A/MCP entry points that bypass the HTTP server ownership check.
      //
      // Rules:
      //  - If the session has no recorded userId/orgId/apiKey (legacy/NoAuth), always allow (back-compat).
      //  - userId is canonical when present; orgId cannot override a user mismatch.
      //  - otherwise orgId is canonical, then apiKey as the legacy fallback.
      const sessionOwned = session.userId !== undefined || session.orgId !== undefined || session.apiKey !== undefined;
      if (sessionOwned && !matchesSessionOwner(session, deps)) {
        throw new StoreConflictError(
          `session ${deps.sessionId} is owned by a different principal`,
        );
      }
    }
    const raw = await store.readEvents(deps.sessionId);
    // §19.1: apply the upcaster chain so the loop always sees events at EVENT_SCHEMA_VERSION.
    // At v1 with no upcasters this is an identity pass (same array reference, zero allocation).
    const existing = upcastEvents(raw, deps.upcasters);
    const nextSeq = existing.length === 0 ? 0 : existing[existing.length - 1]!.seq + 1;
    return new Session(store, deps, nextSeq, existing);
  }

  get seq(): number {
    return this._seq;
  }
  get id(): string {
    return this.deps.sessionId;
  }

  async append(kind: EventKind, payload: unknown, meta?: { usage?: Usage }): Promise<StoredEvent> {
    const event: StoredEvent = {
      id: this.deps.newId(),
      sessionId: this.deps.sessionId,
      seq: this._seq++,
      kind,
      schemaVersion: EVENT_SCHEMA_VERSION,
      payload,
      meta,
      createdAt: this.deps.now(),
    };
    await this.store.appendEvents([event]);
    this._cache.push(event);
    return event;
  }

  events(): StoredEvent[] {
    return this._cache;
  }
}
