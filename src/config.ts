/** Configuration, entirely from environment variables — see .env.example. */

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable ${name}`);
    }
    return fallback;
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} is not a number: ${raw}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  secret: string;

  /**
   * Hard ceiling on avatar size, in bytes.
   *
   * The real per-player limit is signed into the token by the Minecraft plugin, which is
   * the only side that knows about permission groups. This is a safety valve so a broken
   * or outdated plugin cannot make the service accept absurd uploads — set it comfortably
   * above the plugin's own limit and forget about it.
   */
  maxAvatarSizeCeiling: number;

  uploadRate: number;
  downloadRate: number;

  motd: string;
  versionRelease: string;
  versionPrerelease: string;

  assetsProxy: boolean;
  assetsUpstream: string;

  /**
   * Fallback path for unmodified clients: /auth/id -> joinServer -> /auth/verify.
   * Useless for offline players by construction; kept so this service stays a drop-in
   * replacement for the Java plugin.
   */
  sessionAuthEnabled: boolean;
  hasJoinedUrl: string;
  sessionTokenTtlMinutes: number;

  /**
   * Avatars of players who stopped coming are the only thing here that grows without
   * bound — one file per player who ever joined. The sweep drops the ones nobody has
   * touched in a while; "touched" means the owner made an authenticated request, not
   * that somebody downloaded the file, because clients cache avatars by hash and an
   * active player's avatar may go for weeks without being fetched again.
   */
  cleanupEnabled: boolean;
  cleanupInactiveDays: number;
  cleanupIntervalHours: number;

  /** Enables /api/admin/*. Empty disables those routes entirely. */
  adminToken: string;

  wsKeepaliveSeconds: number;
  debug: boolean;
}

export function loadConfig(): Config {
  return {
    host: str("FIGURA_HOST", "0.0.0.0"),
    port: int("FIGURA_PORT", 8080),
    dataDir: str("FIGURA_DATA_DIR", "/data"),
    secret: str("FIGURA_SECRET"),

    maxAvatarSizeCeiling: int("FIGURA_MAX_AVATAR_SIZE_CEILING", 4 * 1024 * 1024),

    uploadRate: int("FIGURA_UPLOAD_RATE", 1_000_000),
    downloadRate: int("FIGURA_DOWNLOAD_RATE", 1_000_000),

    motd: str("FIGURA_MOTD", ""),
    versionRelease: str("FIGURA_VERSION_RELEASE", "0.1.6"),
    versionPrerelease: str("FIGURA_VERSION_PRERELEASE", "0.1.6"),

    assetsProxy: bool("FIGURA_ASSETS_PROXY", true),
    assetsUpstream: str("FIGURA_ASSETS_UPSTREAM", "https://figura.moonlight-devs.org/api")
      .replace(/\/$/, ""),

    cleanupEnabled: bool("FIGURA_CLEANUP_ENABLED", true),
    cleanupInactiveDays: int("FIGURA_CLEANUP_INACTIVE_DAYS", 90),
    cleanupIntervalHours: int("FIGURA_CLEANUP_INTERVAL_HOURS", 24),

    adminToken: str("FIGURA_ADMIN_TOKEN", ""),

    sessionAuthEnabled: bool("FIGURA_SESSION_AUTH", true),
    hasJoinedUrl: str(
      "FIGURA_HAS_JOINED_URL",
      "https://sessionserver.mojang.com/session/minecraft/hasJoined",
    ),
    sessionTokenTtlMinutes: int("FIGURA_SESSION_TOKEN_TTL_MINUTES", 720),

    wsKeepaliveSeconds: int("FIGURA_WS_KEEPALIVE_SECONDS", 30),
    debug: bool("FIGURA_DEBUG", false),
  };
}
