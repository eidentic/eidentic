import type { StoredEvent } from "./protocol.js";
import { EVENT_SCHEMA_VERSION } from "./protocol.js";
import { EidenticError } from "./errors.js";

/**
 * Pure function upgrading a StoredEvent from schemaVersion n to n+1.
 * The returned event MUST have schemaVersion === input.schemaVersion + 1.
 */
export type Upcaster = (e: StoredEvent) => StoredEvent;

/**
 * Error thrown when an event cannot be brought up to the current schema version
 * because no upcaster is registered for its version gap.
 */
export class EventUnupcastableError extends EidenticError {
  readonly class = "protocol" as const;
  constructor(fromVersion: number, toVersion: number) {
    super(
      "event.unupcastable",
      `No upcaster registered for event schemaVersion ${fromVersion} → ${fromVersion + 1} ` +
        `(current EVENT_SCHEMA_VERSION is ${toVersion}). ` +
        `Register an upcaster in AgentConfig.upcasters to replay this log.`,
      { retryable: false, context: { fromVersion, toVersion } },
    );
  }
}

/**
 * Built-in upcaster registry. Currently empty because we are at EVENT_SCHEMA_VERSION = 1
 * (there is no prior version to upgrade from). When the schema bumps to v2, add:
 *   DEFAULT_UPCASTERS[1] = (e) => { ...transform...; return { ...e, schemaVersion: 2 } };
 */
export const DEFAULT_UPCASTERS: Record<number, Upcaster> = {};

/**
 * Apply the registered upcaster chain to bring a single event up to EVENT_SCHEMA_VERSION.
 * At v1 with an already-v1 event this is an identity pass (zero cost).
 *
 * @param e - The event to upcast (may be mutated only by the upcaster; the original is not mutated here).
 * @param upcasters - Custom upcaster registry. Merged on top of DEFAULT_UPCASTERS (custom wins).
 *   Pass undefined to use only the built-in registry.
 * @throws EventUnupcastableError when a required upcaster is absent.
 */
export function upcastEvent(
  e: StoredEvent,
  upcasters?: Record<number, Upcaster>,
): StoredEvent {
  const registry: Record<number, Upcaster> = { ...DEFAULT_UPCASTERS, ...upcasters };
  let current = e;
  while (current.schemaVersion < EVENT_SCHEMA_VERSION) {
    const fn = registry[current.schemaVersion];
    if (!fn) {
      throw new EventUnupcastableError(current.schemaVersion, EVENT_SCHEMA_VERSION);
    }
    current = fn(current);
  }
  return current;
}

/**
 * Apply upcasting to a whole event log (maps each event through upcastEvent).
 * At v1 with all-v1 events this is a cheap identity pass over the array.
 *
 * @param events - The events to upcast (in-order; the array itself is not mutated).
 * @param upcasters - Custom upcaster registry (merged on top of DEFAULT_UPCASTERS).
 * @throws EventUnupcastableError on the first event that cannot be upcasted.
 */
export function upcastEvents(
  events: StoredEvent[],
  upcasters?: Record<number, Upcaster>,
): StoredEvent[] {
  // Fast path: if all events are already at current version and no custom upcasters are
  // needed, return the same array reference (zero allocation). This is the common case
  // at v1 and ensures the seam adds zero overhead to normal operation.
  if (events.every((e) => e.schemaVersion >= EVENT_SCHEMA_VERSION) && !upcasters) {
    return events;
  }
  return events.map((e) => upcastEvent(e, upcasters));
}
