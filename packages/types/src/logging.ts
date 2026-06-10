// --- Structured logging port (§logger) ---

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Structured, namespaced logger port. Implementations route to console (dev) or
 * pino/datadog/OTel-logs (prod). The framework uses this internally; host code
 * injects a concrete implementation via `AgentConfig.logger`.
 */
export interface LoggerPort {
  log(level: LogLevel, namespace: string, message: string, fields?: LogFields): void;
  /**
   * Optional: lets callers skip building expensive `fields` when a (level, namespace) pair is
   * disabled. If absent, the caller assumes the level+namespace is enabled.
   */
  enabled?(level: LogLevel, namespace: string): boolean;
}
