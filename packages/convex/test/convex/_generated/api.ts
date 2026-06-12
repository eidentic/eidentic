/**
 * Stub `_generated/api.ts`. convex-test uses the presence of a `_generated` file in the modules
 * glob to locate the convex modules root; it does NOT need real codegen for the string-path refs
 * this adapter uses. In a real host app this file is produced by `npx convex dev` / `codegen`.
 */
import { anyApi } from "convex/server";

export const api = anyApi;
export const internal = anyApi;
