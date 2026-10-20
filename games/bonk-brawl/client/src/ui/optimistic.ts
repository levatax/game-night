// Optimistic UI value: show the user's choice immediately, fall back to the server's truth once it
// agrees or after a timeout (so a rejected change doesn't stick). Owner: client-ui.

const DEFAULT_HOLD_MS = 1500;

export class Optimistic<T> {
  private value: T | null = null;
  private until = 0;

  constructor(private readonly holdMs = DEFAULT_HOLD_MS) {}

  set(value: T): void {
    this.value = value;
    this.until = performance.now() + this.holdMs;
  }

  /** The value to display given the latest model value. */
  resolve(modelValue: T): T {
    if (this.value === null) return modelValue;
    if (this.value === modelValue || performance.now() > this.until) {
      this.value = null;
      return modelValue;
    }
    return this.value;
  }

  get pending(): boolean {
    return this.value !== null && performance.now() <= this.until;
  }

  clear(): void {
    this.value = null;
  }
}
