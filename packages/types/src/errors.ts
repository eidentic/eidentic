export type ErrorClass =
  | "provider" | "validation" | "permission" | "tool" | "memory"
  | "store" | "durable" | "budget" | "cancelled"
  | "sandbox" | "governance" | "protocol";

export abstract class EidenticError extends Error {
  abstract readonly class: ErrorClass;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.context = opts.context ?? {};
    this.name = this.constructor.name;
  }
}

export class BudgetError extends EidenticError {
  readonly class = "budget" as const;
  constructor(kind: "max_turns" | "max_cost" | "max_wall_clock", message: string) {
    super(`budget.${kind}`, message, { retryable: false });
  }
}

export class ValidationError extends EidenticError {
  readonly class = "validation" as const;
  constructor(message: string, context?: Record<string, unknown>) {
    super("validation.tool_input_invalid", message, { retryable: false, context });
  }
}

export class ToolError extends EidenticError {
  readonly class = "tool" as const;
  constructor(code: string, message: string, opts?: { retryable?: boolean; cause?: unknown }) {
    super(`tool.${code}`, message, opts);
  }
}

export class StoreConflictError extends EidenticError {
  readonly class = "store" as const;
  constructor(message: string) {
    super("store.conflict", message, { retryable: false });
  }
}
