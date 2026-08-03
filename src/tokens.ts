import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Bearer tokens minted by the Minecraft plugin.
 *
 * The plugin signs a token when a player authenticates; this service only verifies the
 * signature. Nothing is shared between the two but the secret — no database, no network
 * call, no startup ordering. That is also why premium and offline players are
 * indistinguishable here: by this point identity is already settled and all we see is a UUID.
 *
 * Wire format, and it must match TokenStore.java byte for byte:
 *
 *   token   = base64url(payload) + "." + base64url(hmacSha256(secret, payload))
 *   payload = uuid <US> name <US> expiresAt <US> maxAvatarSize <US> maxAvatars
 *                  <US> uploadRate <US> downloadRate <US> pingRateLimit <US> pingSizeLimit
 *
 * where <US> is U+001F and expiresAt is epoch milliseconds.
 */

const SEP = String.fromCharCode(0x1f);
const FIELD_COUNT = 9;

export interface Limits {
  maxAvatarSize: number;
  maxAvatars: number;
  uploadRate: number;
  downloadRate: number;
  pingRateLimit: number;
  pingSizeLimit: number;
}

export interface Session {
  uuid: string;
  name: string;
  limits: Limits;
  expiresAt: number;
}

export class TokenVerifier {
  readonly #secret: Buffer;

  constructor(secret: string) {
    this.#secret = Buffer.from(secret, "utf8");
  }

  /**
   * Mints a token. Only the session-auth fallback needs this — normally the Minecraft
   * plugin is the one signing, and this service merely verifies.
   */
  sign(uuid: string, name: string, limits: Limits, ttlMillis: number): string {
    const payload = [
      uuid,
      name.replaceAll(SEP, "_"),
      String(Date.now() + ttlMillis),
      String(limits.maxAvatarSize),
      String(limits.maxAvatars),
      String(limits.uploadRate),
      String(limits.downloadRate),
      String(limits.pingRateLimit),
      String(limits.pingSizeLimit),
    ].join(SEP);

    const raw = Buffer.from(payload, "utf8");
    const signature = createHmac("sha256", this.#secret).update(raw).digest();
    return `${raw.toString("base64url")}.${signature.toString("base64url")}`;
  }

  /** Returns the session a token stands for, or null when forged, malformed or expired. */
  verify(token: string | undefined): Session | null {
    if (!token) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    let payload: Buffer;
    let signature: Buffer;
    try {
      payload = Buffer.from(token.slice(0, dot), "base64url");
      signature = Buffer.from(token.slice(dot + 1), "base64url");
    } catch {
      return null;
    }

    const expected = createHmac("sha256", this.#secret).update(payload).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      return null;
    }

    const parts = payload.toString("utf8").split(SEP);
    if (parts.length !== FIELD_COUNT) return null;

    const numbers = parts.slice(2).map((p) => Number.parseInt(p, 10));
    if (numbers.some((n) => !Number.isFinite(n))) return null;

    const [expiresAt, maxAvatarSize, maxAvatars, uploadRate, downloadRate,
           pingRateLimit, pingSizeLimit] = numbers as number[];

    if (Date.now() > expiresAt!) return null;

    const uuid = parts[0]!;
    if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) return null;

    return {
      uuid: uuid.toLowerCase(),
      name: parts[1]!,
      expiresAt: expiresAt!,
      limits: {
        maxAvatarSize: maxAvatarSize!,
        maxAvatars: maxAvatars!,
        uploadRate: uploadRate!,
        downloadRate: downloadRate!,
        pingRateLimit: pingRateLimit!,
        pingSizeLimit: pingSizeLimit!,
      },
    };
  }
}
