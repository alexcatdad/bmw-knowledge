/** Safe errors may be persisted in operational state; upstream error bodies must not be. */
export class CollectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CollectionError";
    this.code = code;
  }
}
