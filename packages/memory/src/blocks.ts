import {
  StoreConflictError,
  type BlockEdit,
  type MemoryBlock,
  type MemoryEvent,
  type Scope,
  type StorePort,
} from "@eidentic/types";

export type BlockSpec = { value?: string; description?: string; limit?: number; readOnly?: boolean };

export interface BlockEditorOptions {
  store: StorePort;
  blocks?: Record<string, string | BlockSpec>;
  ingest: (events: MemoryEvent[]) => Promise<void>;
  newId?: () => string;
}

/** Shared self-editing semantics for Tier-1 blocks. Memory delegates here for its block operations. */
export class BlockEditor {
  private readonly specs: Record<string, BlockSpec>;
  private archiveCounter = 0;

  constructor(private readonly opts: BlockEditorOptions) {
    const normalized: Record<string, BlockSpec> = {};
    for (const [label, raw] of Object.entries(opts.blocks ?? {})) {
      normalized[label] = typeof raw === "string" ? { value: raw } : raw;
    }
    this.specs = normalized;
  }

  private meta(block: MemoryBlock): MemoryBlock {
    const spec = this.specs[block.label];
    if (!spec) return block;
    return { ...block, description: spec.description, limit: spec.limit, readOnly: spec.readOnly };
  }

  async getAlwaysInContext(scope: Scope): Promise<MemoryBlock[]> {
    const existing = await this.opts.store.getBlocks(scope);
    const map = new Map<string, MemoryBlock>(existing.map((b) => [b.label, b]));
    for (const [label, spec] of Object.entries(this.specs)) {
      if (!map.has(label)) {
        const upserted = await this.opts.store.upsertBlock(scope, { label, value: spec.value ?? "" });
        map.set(label, upserted);
      }
    }
    return [...map.values()].map((b) => this.meta(b));
  }

  private async current(scope: Scope, label: string): Promise<MemoryBlock | undefined> {
    return (await this.opts.store.getBlock(scope, label)) ?? undefined;
  }

  async append(scope: Scope, label: string, text: string): Promise<BlockEdit> {
    const spec = this.specs[label];
    if (spec?.readOnly) return { ok: false, reason: "readonly", message: `block '${label}' is read-only` };
    const current = await this.current(scope, label);
    // B5: TOCTOU residual — the limit pre-check below is a best-effort read-then-write guard,
    // NOT an atomic enforcement. Two concurrent append() calls can each pass the check individually,
    // then both call appendBlock() and push the block over the limit. In practice the agent loop
    // dispatches tool batches serially (mutating tools are serialized in dispatch()), so this race
    // only occurs when multiple sessions share the same scope and both append simultaneously.
    //
    // The safe option is to fully enforce the limit inside the store's appendBlock implementation
    // (which IS atomic). That requires a StorePort interface change (pass `limit` to appendBlock)
    // and migration of all three store adapters — deferred to a future changeset.
    //
    // RESIDUAL: under concurrent shared-scope sessions, the committed block value may transiently
    // exceed `limit` by at most `text.length` per concurrent append. For single-agent use (the
    // common case) the serialized dispatch loop means no race occurs and the limit is respected.
    const limit = spec?.limit;
    if (limit !== undefined && (current?.value.length ?? 0) + text.length > limit) {
      return { ok: false, reason: "limit", message: `block '${label}' would exceed limit ${limit}` };
    }
    const block = await this.opts.store.appendBlock(scope, label, text);
    return { ok: true, block: this.meta(block) };
  }

  async replace(scope: Scope, label: string, find: string, replace: string, version: number): Promise<BlockEdit> {
    const spec = this.specs[label];
    if (spec?.readOnly) return { ok: false, reason: "readonly", message: `block '${label}' is read-only` };
    const current = await this.current(scope, label);
    if (!current) return { ok: false, reason: "missing", message: `block '${label}' does not exist` };
    if (!current.value.includes(find)) return { ok: false, reason: "notfound", message: `'${find}' not found in block '${label}'` };
    const newValue = current.value.split(find).join(replace);
    const limit = spec?.limit;
    if (limit !== undefined && newValue.length > limit) {
      return { ok: false, reason: "limit", message: `block '${label}' would exceed limit ${limit}` };
    }
    return this.casWrite(scope, label, newValue, version);
  }

  async rewrite(scope: Scope, label: string, value: string, version: number): Promise<BlockEdit> {
    const spec = this.specs[label];
    if (spec?.readOnly) return { ok: false, reason: "readonly", message: `block '${label}' is read-only` };
    const limit = spec?.limit;
    if (limit !== undefined && value.length > limit) {
      return { ok: false, reason: "limit", message: `block '${label}' would exceed limit ${limit}` };
    }
    return this.casWrite(scope, label, value, version);
  }

  private async casWrite(scope: Scope, label: string, value: string, version: number): Promise<BlockEdit> {
    try {
      const block = await this.opts.store.upsertBlock(scope, { label, value }, version);
      return { ok: true, block: this.meta(block) };
    } catch (e) {
      if (e instanceof StoreConflictError) {
        const current = await this.current(scope, label);
        return {
          ok: false,
          reason: "conflict",
          message: `block '${label}' changed since version ${version}`,
          current: current ? this.meta(current) : undefined,
        };
      }
      throw e;
    }
  }

  async archive(scope: Scope, text: string): Promise<void> {
    const id = this.opts.newId?.() ?? `arc_${Date.now().toString(36)}_${(this.archiveCounter++).toString(36)}`;
    await this.opts.ingest([{ id, scope, text }]);
  }
}
