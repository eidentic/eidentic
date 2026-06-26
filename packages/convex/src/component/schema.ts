import { defineSchema } from "convex/server";
import {
  SINGULAR_EIDENTIC_TABLE_NAMES,
  createEidenticTables,
} from "../schema.js";

export const EIDENTIC_COMPONENT_TABLE_NAMES = SINGULAR_EIDENTIC_TABLE_NAMES;
export const eidenticComponentTables = createEidenticTables({
  names: EIDENTIC_COMPONENT_TABLE_NAMES,
});

export default defineSchema(eidenticComponentTables);
