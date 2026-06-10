"use client";

import { useEidenticStream } from "./useEidenticStream.js";
import type { EidenticStreamState, EidenticStreamOptions } from "./useEidenticStream.js";

/**
 * Convenience hook that targets a Eidentic agent by ID.
 * Derives the query endpoint as `${baseUrl}/v1/agents/${agentId}/query` and
 * the resume endpoint as `${baseUrl}/v1/agents/${agentId}/resume`.
 *
 * @param agentId  The agent ID registered in the Eidentic server.
 * @param baseUrl  Base URL of the Eidentic server (default: "" — same origin).
 * @param opts     Passed through to useEidenticStream.
 */
export function useAgent(
  agentId: string,
  baseUrl = "",
  opts: EidenticStreamOptions = {},
): EidenticStreamState {
  const encodedId = encodeURIComponent(agentId);
  const endpoint = `${baseUrl}/v1/agents/${encodedId}/query`;
  const resumeEndpoint = opts.resumeEndpoint ?? `${baseUrl}/v1/agents/${encodedId}/resume`;
  return useEidenticStream(endpoint, { ...opts, resumeEndpoint });
}
