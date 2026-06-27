import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import {
  EidenticComponentStore,
  EidenticComponentVectorStore,
  convexActionRunner,
  fromActionCtx,
  type ConvexActionCtxLike,
} from "../src/index.js";

declare const ctx: GenericActionCtx<any>;
declare const mutationCtx: GenericMutationCtx<any>;
declare const component: unknown;

convexActionRunner(ctx);
new EidenticComponentStore(ctx, component);
new EidenticComponentVectorStore(ctx, component);
fromActionCtx(ctx, component);

convexActionRunner(mutationCtx);
new EidenticComponentStore(mutationCtx, component);
new EidenticComponentVectorStore(mutationCtx, component);
fromActionCtx(mutationCtx, component);

declare const normalizedCtx: ConvexActionCtxLike;

convexActionRunner(normalizedCtx);
new EidenticComponentStore(normalizedCtx, component);
new EidenticComponentVectorStore(normalizedCtx, component);
fromActionCtx(normalizedCtx, component);
