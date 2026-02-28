export class StoreValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string
  ) {
    super(message);
    this.name = "StoreValidationError";
  }
}

export class StoreOperationError extends Error {
  constructor(
    message: string,
    public readonly store: string,
    public readonly operation: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "StoreOperationError";
  }
}
