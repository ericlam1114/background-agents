export class StoreValidationError extends Error {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "StoreValidationError";
    this.field = field;
  }
}

export class StoreOperationError extends Error {
  public readonly store?: string;
  public readonly operation?: string;
  public readonly cause?: unknown;

  constructor(message: string, store?: string, operation?: string, cause?: unknown) {
    super(message);
    this.name = "StoreOperationError";
    this.store = store;
    this.operation = operation;
    this.cause = cause;
  }
}
