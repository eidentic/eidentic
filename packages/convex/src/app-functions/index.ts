export {
  ConvexStore,
  ConvexVectorStore,
  convexActionRunner,
  convexHttpRunner,
  defaultStoreFns,
  defaultVectorFns,
  storeFnsFrom,
  vectorFnsFrom,
  type ConvexActionCtxLike,
  type ConvexHttpClientLike,
  type ConvexRunner,
  type ConvexStoreFns,
  type ConvexStoreOptions,
  type ConvexVectorFns,
  type ConvexVectorStoreOptions,
  type FnRef,
} from "../index.js";
export {
  DEFAULT_EIDENTIC_TABLE_NAMES,
  SINGULAR_EIDENTIC_TABLE_NAMES,
  createEidenticTableNames,
  createEidenticTables,
  eidenticTables,
  type CreateEidenticTableNamesOptions,
  type CreateEidenticTablesOptions,
  type EidenticTableKey,
  type EidenticTableNames,
} from "../schema.js";
export {
  eidenticFunctions,
  type EidenticAuthorize,
  type EidenticFunctionsOptions,
} from "../server.js";
