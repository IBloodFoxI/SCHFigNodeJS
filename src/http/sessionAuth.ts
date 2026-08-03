import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { TokenVerifier } from "../tokens.js";

/**
 * The stock Figura handshake: the client asks us for a serverId, joins the session server
 * with it, then asks us to verify. Only usable by unmodified clients holding a valid
 * session — offline players never get past their own joinServer call, which is exactly why
 * the plugin-channel path exists alongside this one.
 *
 * Kept for parity with the Java plugin so the two backends stay interchangeable. On a
 * server where everybody runs the fork, nothing ever reaches these endpoints.
 */
export class SessionAuth {
  readonly #pending = new Map<string, { username: string; createdAt: number }>();
  readonly #ttl = 60_000;

  /** Step 1 — hand the client a serverId to join with. */
  newServerId(username: string): string {
    this.#expire();
    const serverId = randomBytes(16).toString("hex");
    this.#pending.set(serverId, { username, createdAt: Date.now() });
    return serverId;
  }

  /**
   * Step 2 — confirm with the session server that the client really joined,
   * then mint a token for the UUID it reports.
   */
  async verify(serverId: string, config: Config, signer: TokenVerifier): Promise<string | null> {
    const pending = this.#pending.get(serverId);
    this.#pending.delete(serverId);
    if (pending === undefined || Date.now() - pending.createdAt > this.#ttl) return null;

    try {
      const url = `${config.hasJoinedUrl}?username=${encodeURIComponent(pending.username)}`
        + `&serverId=${encodeURIComponent(serverId)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

      // 204 with an empty body is the documented "did not join" answer.
      if (!response.ok) return null;
      const text = await response.text();
      if (text.trim() === "") return null;

      const body = JSON.parse(text) as { id?: string; name?: string };
      if (typeof body.id !== "string") return null;

      const uuid = dashed(body.id);
      if (uuid === null) return null;

      return signer.sign(
        uuid,
        body.name ?? pending.username,
        {
          maxAvatarSize: config.maxAvatarSizeCeiling,
          maxAvatars: 1,
          uploadRate: config.uploadRate,
          downloadRate: config.downloadRate,
          pingRateLimit: 64,
          pingSizeLimit: 1024,
        },
        config.sessionTokenTtlMinutes * 60_000,
      );
    } catch {
      return null;
    }
  }

  #expire(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (now - pending.createdAt > this.#ttl) this.#pending.delete(id);
    }
  }
}

function dashed(id: string): string | null {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
