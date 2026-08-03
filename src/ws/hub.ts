import type { WebSocket } from "ws";
import type { Limits, Session, TokenVerifier } from "../tokens.js";

/**
 * The Figura websocket: pings between players, avatar-change events, subscriptions.
 *
 * C2S opcodes mirror C2SMessageHandler in the mod, S2C mirror S2CMessageHandler.
 */
const C2S = { TOKEN: 0, PING: 1, SUB: 2, UNSUB: 3 } as const;
const S2C = { AUTH: 0, PING: 1, EVENT: 2, TOAST: 3, CHAT: 4, NOTICE: 5 } as const;
const NOTICE = { PING_SIZE: 0, PING_RATE: 1 } as const;

interface Client {
  socket: WebSocket;
  uuid: string | null;
  limits: Limits | null;
  subscriptions: Set<string>;
  rateWindowStart: number;
  pingsThisWindow: number;
  lastRateNotice: number;
  lastSizeNotice: number;
  alive: boolean;
}

export class WsHub {
  readonly #clients = new Set<Client>();
  /** subject uuid -> clients that asked to hear about it */
  readonly #subscribers = new Map<string, Set<Client>>();
  readonly #tokens: TokenVerifier;
  readonly #debug: boolean;
  readonly #log: (message: string) => void;

  constructor(tokens: TokenVerifier, debug: boolean, log: (message: string) => void) {
    this.#tokens = tokens;
    this.#debug = debug;
    this.#log = log;
  }

  get connectionCount(): number {
    return this.#clients.size;
  }

  accept(socket: WebSocket): void {
    const client: Client = {
      socket,
      uuid: null,
      limits: null,
      subscriptions: new Set(),
      rateWindowStart: Date.now(),
      pingsThisWindow: 0,
      lastRateNotice: 0,
      lastSizeNotice: 0,
      alive: true,
    };
    this.#clients.add(client);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      // Figura only ever speaks binary here; the mod ignores text frames on its side too.
      if (!isBinary) return;
      try {
        this.#handle(client, data);
      } catch (error) {
        if (this.#debug) this.#log(`[ws] malformed frame: ${String(error)}`);
      }
    });

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("close", () => this.#drop(client));
    socket.on("error", () => this.#drop(client));
  }

  #drop(client: Client): void {
    this.#clients.delete(client);
    for (const subject of client.subscriptions) {
      const set = this.#subscribers.get(subject);
      if (set) {
        set.delete(client);
        if (set.size === 0) this.#subscribers.delete(subject);
      }
    }
    client.subscriptions.clear();
  }

  #handle(client: Client, data: Buffer): void {
    if (data.length === 0) return;
    const opcode = data.readUInt8(0);

    switch (opcode) {
      case C2S.TOKEN: {
        const session = this.#tokens.verify(data.subarray(1).toString("utf8"));
        if (session === null) {
          // Nothing in the client's close-code table maps cleanly to "bad token"; it
          // reconnects on any close and a fresh token arrives on the next join anyway.
          client.socket.close(1008, "unauthorized");
          return;
        }
        this.#authenticate(client, session);
        return;
      }

      case C2S.PING: {
        if (client.uuid === null || client.limits === null) return;
        const id = data.readInt32BE(1);
        const sync = data.readUInt8(5) !== 0;
        const payload = data.subarray(6);

        if (payload.length > client.limits.pingSizeLimit) {
          this.#notice(client, NOTICE.PING_SIZE);
          return;
        }
        if (!allowRate(client)) {
          this.#notice(client, NOTICE.PING_RATE);
          return;
        }
        this.#relayPing(client.uuid, id, sync, payload);
        return;
      }

      case C2S.SUB:
      case C2S.UNSUB: {
        if (client.uuid === null) return;
        const subject = readUuid(data, 1);
        if (opcode === C2S.SUB) this.#subscribe(client, subject);
        else this.#unsubscribe(client, subject);
        return;
      }

      default:
        // Unknown opcode — a newer client, nothing to do.
        return;
    }
  }

  #authenticate(client: Client, session: Session): void {
    client.uuid = session.uuid;
    client.limits = session.limits;
    client.socket.send(Buffer.from([S2C.AUTH]));
    if (this.#debug) this.#log(`[ws] authenticated ${session.name} (${session.uuid})`);
  }

  #subscribe(client: Client, subject: string): void {
    client.subscriptions.add(subject);
    let set = this.#subscribers.get(subject);
    if (set === undefined) {
      set = new Set();
      this.#subscribers.set(subject, set);
    }
    set.add(client);
  }

  #unsubscribe(client: Client, subject: string): void {
    client.subscriptions.delete(subject);
    const set = this.#subscribers.get(subject);
    if (set) {
      set.delete(client);
      if (set.size === 0) this.#subscribers.delete(subject);
    }
  }

  /** Relays a Lua ping from its author to everyone rendering that author's avatar. */
  #relayPing(sender: string, id: number, sync: boolean, payload: Buffer): void {
    const watchers = this.#subscribers.get(sender);
    if (watchers === undefined || watchers.size === 0) return;

    const message = Buffer.allocUnsafe(22 + payload.length);
    message.writeUInt8(S2C.PING, 0);
    writeUuid(message, 1, sender);
    message.writeInt32BE(id, 17);
    message.writeUInt8(sync ? 1 : 0, 21);
    payload.copy(message, 22);

    for (const watcher of watchers) {
      // The author already ran the ping locally; echoing it back would double-fire it.
      if (watcher.uuid === sender) continue;
      send(watcher, message);
    }
  }

  /** Tells subscribers that a player's avatar changed, so they refetch it. */
  broadcastAvatarChanged(subject: string): void {
    const watchers = this.#subscribers.get(subject);
    if (watchers === undefined || watchers.size === 0) return;

    const message = Buffer.allocUnsafe(17);
    message.writeUInt8(S2C.EVENT, 0);
    writeUuid(message, 1, subject);

    for (const watcher of watchers) send(watcher, message);
  }

  /** One toast per notice type per 5s, so a runaway script cannot spam the player. */
  #notice(client: Client, type: number): void {
    const now = Date.now();
    if (type === NOTICE.PING_RATE) {
      if (now - client.lastRateNotice < 5000) return;
      client.lastRateNotice = now;
    } else {
      if (now - client.lastSizeNotice < 5000) return;
      client.lastSizeNotice = now;
    }
    send(client, Buffer.from([S2C.NOTICE, type]));
  }

  /**
   * Pings every live socket. Figura's connection is idle whenever nobody runs Lua pings,
   * and both nginx and Cloudflare drop idle connections; this keeps traffic on the wire
   * and reaps sockets that stopped answering.
   */
  keepAlive(): void {
    for (const client of [...this.#clients]) {
      if (!client.alive) {
        client.socket.terminate();
        this.#drop(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        this.#drop(client);
      }
    }
  }

  closeAll(): void {
    for (const client of [...this.#clients]) {
      try {
        client.socket.close(1001, "server shutting down");
      } catch {
        // already gone
      }
    }
    this.#clients.clear();
    this.#subscribers.clear();
  }
}

/** Fixed one-second window — coarse, but it matches how the client paces pings. */
function allowRate(client: Client): boolean {
  const now = Date.now();
  if (now - client.rateWindowStart >= 1000) {
    client.rateWindowStart = now;
    client.pingsThisWindow = 0;
  }
  client.pingsThisWindow += 1;
  return client.pingsThisWindow <= client.limits!.pingRateLimit;
}

function send(client: Client, message: Buffer): void {
  try {
    client.socket.send(message);
  } catch {
    // The close handler will clean it up.
  }
}

function readUuid(buffer: Buffer, offset: number): string {
  const hex = buffer.subarray(offset, offset + 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeUuid(buffer: Buffer, offset: number, uuid: string): void {
  buffer.write(uuid.replace(/-/g, ""), offset, "hex");
}
