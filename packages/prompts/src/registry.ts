import { sha256, keyToFraction } from "./hash.js";
import { memoryPromptStore } from "./memory-store.js";
import type {
  CanaryResult,
  HistoryEvent,
  PromptStore,
  PromptStoreState,
  PromptVersion,
} from "./types.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RegisterOptions {
  /**
   * Arbitrary key/value tags attached to this version for filtering.
   * Not to be confused with named deployment tags (stable, candidate, …).
   * Example: `{ model: "gpt-4o", owner: "alice" }`
   */
  tags?: Record<string, string>;
  /** Arbitrary caller-supplied metadata (ticket, environment, …). */
  meta?: Record<string, unknown>;
}

/**
 * Options for {@link PromptRegistry.canary}.
 */
export interface CanaryOptions {
  /**
   * Reference for the "stable" (control) arm.
   * A version number, a named deployment tag (e.g. `"stable"`), or `undefined`
   * to use the latest version.
   */
  stable?: number | string;
  /**
   * Reference for the "candidate" (treatment) arm.
   * A version number, a named deployment tag (e.g. `"candidate"`), or
   * `undefined` to use the latest version.
   */
  candidate?: number | string;
  /**
   * Fraction of traffic to route to the candidate arm. A value in [0, 1].
   * `0.1` means 10 % candidate / 90 % stable.
   */
  fraction: number;
  /**
   * Routing key (e.g. a session ID or user ID). The same key always resolves
   * to the same arm for a given `fraction`, providing deterministic splitting
   * without persistent state.
   */
  key: string;
}

// ─── Registry interface ───────────────────────────────────────────────────────

export interface PromptRegistry {
  /**
   * Register a new version of a prompt.
   *
   * **Immutability rule:** if the same `body` was already registered under
   * `name` (detected by SHA-256 hash), the existing version is returned as-is
   * and no new record is created. A changed body always produces a new
   * incrementing version number.
   *
   * @param name — logical prompt name (e.g. `"support-agent-system"`).
   * @param body — raw prompt text.
   * @param options — optional tags and metadata.
   * @returns the existing or newly-created {@link PromptVersion}.
   */
  register(
    name: string,
    body: string,
    options?: RegisterOptions,
  ): Promise<PromptVersion>;

  /**
   * Retrieve a prompt version by name and an optional reference.
   *
   * @param name — logical prompt name.
   * @param ref — version number | named deployment tag | `undefined` (→ latest).
   * @returns the matched {@link PromptVersion}.
   * @throws if the name has no versions, or the ref cannot be resolved.
   */
  get(name: string, ref?: number | string): Promise<PromptVersion>;

  /**
   * Assign (or move) a named deployment tag to a specific version.
   *
   * Moving the `"stable"` tag from one version to an earlier one IS a rollback.
   * Every tag move is recorded in the history so you have a full audit trail.
   *
   * @param name — logical prompt name.
   * @param version — version number to tag.
   * @param tag — deployment tag name (e.g. `"stable"`, `"candidate"`).
   */
  tag(name: string, version: number, tag: string): Promise<void>;

  /**
   * Remove a named deployment tag from a prompt.
   *
   * The removal is recorded in the history audit log.
   *
   * @param name — logical prompt name.
   * @param tag — deployment tag name to remove.
   */
  untag(name: string, tag: string): Promise<void>;

  /**
   * Return all history events for a prompt: version registrations and every
   * tag-move/untag, oldest-first.
   *
   * @param name — logical prompt name.
   */
  history(name: string): Promise<HistoryEvent[]>;

  /**
   * Deterministic canary split: resolve two prompt versions and route `key`
   * into one of them based on `fraction`.
   *
   * The same key always resolves to the same arm for a given fraction — no
   * server-side state is required. Record the returned `arm` alongside your
   * eval metadata to compare outcomes across arms.
   *
   * @example
   * ```ts
   * const result = await registry.canary("support-agent-system", {
   *   stable: "stable",
   *   candidate: "candidate",
   *   fraction: 0.1,
   *   key: sessionId,
   * });
   * const agent = createAgent({ instructions: result.body });
   * // … later, record result.arm in your eval metadata
   * ```
   */
  canary(name: string, options: CanaryOptions): Promise<CanaryResult>;
}

// ─── createPromptRegistry() ───────────────────────────────────────────────────

/**
 * Create a new {@link PromptRegistry}.
 *
 * @param store — optional persistence adapter. Defaults to an in-memory store.
 *
 * @example
 * ```ts
 * // In-memory (default) — for tests / scripts:
 * const registry = createPromptRegistry();
 *
 * // Crash-safe file store — for production servers:
 * import { filePromptStore } from "@eidentic/prompts";
 * const registry = createPromptRegistry(filePromptStore("./data/prompts.json"));
 * ```
 *
 * ### Using with AgentConfig.instructions
 * ```ts
 * import { createAgent } from "@eidentic/core";
 * import { createPromptRegistry, filePromptStore, renderPrompt } from "@eidentic/prompts";
 *
 * const registry = createPromptRegistry(filePromptStore("./data/prompts.json"));
 *
 * // On each request, resolve the current stable prompt and render vars:
 * async function handleQuery(sessionId: string, userQuery: string) {
 *   const prompt = await registry.get("support-agent-system", "stable");
 *   const instructions = renderPrompt(prompt.body, { date: new Date().toISOString() });
 *
 *   const agent = createAgent({ instructions });
 *   // …run the agent…
 * }
 *
 * // Canary: 10 % of sessions get the candidate prompt
 * async function handleQueryCanary(sessionId: string, userQuery: string) {
 *   const { body, arm } = await registry.canary("support-agent-system", {
 *     stable: "stable",
 *     candidate: "candidate",
 *     fraction: 0.1,
 *     key: sessionId,
 *   });
 *   const agent = createAgent({ instructions: body });
 *   // Record `arm` in your eval metadata for offline comparison:
 *   await evalStore.log({ sessionId, promptArm: arm });
 *   // …run the agent…
 * }
 * ```
 */
export function createPromptRegistry(store?: PromptStore): PromptRegistry {
  const s = store ?? memoryPromptStore();

  // Serialize ALL mutating operations (register, tag, untag) through this
  // chain so concurrent callers never race on load → save.
  let mutationChain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = mutationChain.then(fn, fn);
    // Keep the chain live even if fn rejects (errors propagate to the caller
    // via `next`, not via the chain itself).
    mutationChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  async function loadState(): Promise<PromptStoreState> {
    const loaded = await s.load();
    return loaded ?? { versions: [], tags: {}, history: [] };
  }

  async function mutateState<T>(mutator: (state: PromptStoreState) => T | Promise<T>): Promise<T> {
    if (s.transact) return s.transact(mutator);
    const state = await loadState();
    const result = await mutator(state);
    await s.save(state);
    return result;
  }

  function tagKey(name: string, tag: string): string {
    return `${name}/${tag}`;
  }

  function versionsFor(state: PromptStoreState, name: string): PromptVersion[] {
    return state.versions.filter((v) => v.name === name);
  }

  function resolveRef(
    state: PromptStoreState,
    name: string,
    ref: number | string | undefined,
  ): PromptVersion {
    const all = versionsFor(state, name);
    if (all.length === 0) {
      throw new Error(`@eidentic/prompts: no versions registered for "${name}"`);
    }

    if (ref === undefined) {
      // Latest = highest version number
      return all.reduce((a, b) => (a.version > b.version ? a : b));
    }

    if (typeof ref === "number") {
      const found = all.find((v) => v.version === ref);
      if (!found) {
        throw new Error(
          `@eidentic/prompts: version ${ref} not found for "${name}"`,
        );
      }
      return found;
    }

    // String ref → named deployment tag
    const versionNum = state.tags[tagKey(name, ref)];
    if (versionNum === undefined) {
      throw new Error(
        `@eidentic/prompts: tag "${ref}" not found for "${name}"`,
      );
    }
    const found = all.find((v) => v.version === versionNum);
    if (!found) {
      throw new Error(
        `@eidentic/prompts: tag "${ref}" points to version ${versionNum} which no longer exists for "${name}"`,
      );
    }
    return found;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  return {
    register(
      name: string,
      body: string,
      options: RegisterOptions = {},
    ): Promise<PromptVersion> {
      return enqueue(() => mutateState(async (state) => {
      const hash = sha256(body);

      // Dedup: if an identical body already exists for this name, return it.
      const existing = state.versions.find(
        (v) => v.name === name && v.hash === hash,
      );
      if (existing) return existing;

      const all = versionsFor(state, name);
      const nextVersion =
        all.length === 0 ? 1 : Math.max(...all.map((v) => v.version)) + 1;

      const pv: PromptVersion = {
        name,
        version: nextVersion,
        hash,
        body,
        createdAt: new Date().toISOString(),
        tags: options.tags ?? {},
        meta: options.meta ?? {},
      };

      state.versions.push(pv);
      state.history.push({
        kind: "version_registered",
        name,
        version: nextVersion,
        hash,
        createdAt: pv.createdAt,
      });

      return pv;
      })); // end enqueue
    },

    get(name: string, ref?: number | string): Promise<PromptVersion> {
      // Read-only: no mutation, no serialisation needed.
      return loadState().then((state) => resolveRef(state, name, ref));
    },

    tag(name: string, version: number, tagName: string): Promise<void> {
      return enqueue(() => mutateState(async (state) => {

        // Verify the version exists for this name
        const all = versionsFor(state, name);
        if (all.length === 0) {
          throw new Error(`@eidentic/prompts: no versions registered for "${name}"`);
        }
        if (!all.find((v) => v.version === version)) {
          throw new Error(
            `@eidentic/prompts: version ${version} not found for "${name}"`,
          );
        }

        const key = tagKey(name, tagName);
        const fromVersion = state.tags[key] ?? null;

        state.tags[key] = version;
        state.history.push({
          kind: "tag_moved",
          name,
          tag: tagName,
          fromVersion,
          toVersion: version,
          createdAt: new Date().toISOString(),
        });

      })); // end enqueue
    },

    untag(name: string, tagName: string): Promise<void> {
      return enqueue(() => mutateState(async (state) => {
        const key = tagKey(name, tagName);
        const fromVersion = state.tags[key];
        if (fromVersion === undefined) {
          throw new Error(
            `@eidentic/prompts: tag "${tagName}" not found for "${name}"`,
          );
        }

        delete state.tags[key];
        state.history.push({
          kind: "tag_removed",
          name,
          tag: tagName,
          fromVersion,
          createdAt: new Date().toISOString(),
        });

      })); // end enqueue
    },

    async history(name: string): Promise<HistoryEvent[]> {
      const state = await loadState();
      return state.history.filter((e) => e.name === name);
    },

    async canary(name: string, options: CanaryOptions): Promise<CanaryResult> {
      const { stable, candidate, fraction, key } = options;

      if (fraction < 0 || fraction > 1) {
        throw new RangeError(
          `@eidentic/prompts: canary fraction must be in [0, 1], got ${fraction}`,
        );
      }

      const state = await loadState();
      const stableVersion = resolveRef(state, name, stable);
      const candidateVersion = resolveRef(state, name, candidate);

      const f = keyToFraction(key);
      const arm: "stable" | "candidate" = f < fraction ? "candidate" : "stable";
      const resolved = arm === "candidate" ? candidateVersion : stableVersion;

      return {
        body: resolved.body,
        version: resolved.version,
        arm,
      };
    },
  };
}
