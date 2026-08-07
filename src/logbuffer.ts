/**
 * Keeps the last N log lines in memory so they can be pulled over HTTP.
 *
 * <p>The point is the Minecraft server console: the FiguraLink plugin polls
 * {@code /api/admin/logs} and mirrors new lines there, so an admin does not have to shell
 * into the host and run `docker logs` to see what the backend is doing.
 *
 * <p>Each line gets a monotonic sequence number, and callers ask for everything after the
 * one they already have. That makes the poll stateless on our side and idempotent on theirs
 * — a missed poll catches up, a repeated poll shows nothing twice.
 */
export interface LogLine {
  seq: number;
  time: string;
  message: string;
}

export class LogBuffer {
  readonly #lines: LogLine[] = [];
  readonly #capacity: number;
  #nextSeq = 1;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  push(message: string): LogLine {
    const line: LogLine = {
      seq: this.#nextSeq++,
      time: new Date().toISOString(),
      message,
    };
    this.#lines.push(line);
    if (this.#lines.length > this.#capacity) {
      this.#lines.splice(0, this.#lines.length - this.#capacity);
    }
    return line;
  }

  /**
   * Lines after `since`. A `since` of 0 means "give me the tail", which is what a freshly
   * started poller wants — it should not replay hours of history into the console.
   */
  after(since: number, limit: number): { lines: LogLine[]; next: number } {
    const capped = Math.max(1, Math.min(limit, this.#capacity));

    let selected: LogLine[];
    if (since <= 0) {
      selected = this.#lines.slice(-capped);
    } else {
      selected = this.#lines.filter((line) => line.seq > since).slice(0, capped);
    }

    const next = selected.length > 0
      ? selected[selected.length - 1]!.seq
      : Math.max(since, this.#nextSeq - 1);

    return { lines: selected, next };
  }

  /** Sequence the next line will get minus one, i.e. the newest line's number. */
  get head(): number {
    return this.#nextSeq - 1;
  }
}
