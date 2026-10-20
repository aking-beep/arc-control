/**
 * A minimal FIFO async mutex. The audit chain and the approval lifecycle both
 * depend on read-modify-write sequences being serialized; without this, two
 * concurrent appends could claim the same sequence number and silently fork
 * the chain.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(critical: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await critical();
    } finally {
      release();
    }
  }
}
