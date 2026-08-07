import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { AssetCache, mimeFor } from "../stores/assets.js";
import { AvatarStore } from "../stores/avatars.js";
import type { Equipped, UserStore } from "../stores/users.js";
import type { Session, TokenVerifier } from "../tokens.js";
import type { WsHub } from "../ws/hub.js";
import type { LogBuffer } from "../logbuffer.js";
import { SessionAuth } from "./sessionAuth.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** How long after an upload an equip still counts as "the player equipping their own". */
const SELF_EQUIP_WINDOW_MS = 120_000;

export interface ApiDeps {
  config: Config;
  tokens: TokenVerifier;
  avatars: AvatarStore;
  users: UserStore;
  assets: AssetCache;
  hub: WsHub;
  log: (message: string) => void;
  logs: LogBuffer;
}

/**
 * The Figura backend2 HTTP API, based at `/api`.
 *
 * The client derives both `https://<addr>/api` and `wss://<addr>/ws` from one configured
 * address, so these cannot be split across two listeners — the websocket upgrade is wired
 * onto the same server in index.ts.
 */
export function createApiHandler(deps: ApiDeps) {
  const { config, tokens, avatars, users, assets, hub, log } = deps;
  const sessionAuth = new SessionAuth();
  /** uuid -> when they last uploaded; see the self-equip note in equip(). */
  const recentUploads = new Map<string, number>();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (config.debug) log(`[http] ${req.method} ${url.pathname}`);

    if (!url.pathname.startsWith("/api")) {
      return text(res, 404, "not found");
    }

    let path = url.pathname.slice("/api".length);
    if (path.startsWith("/")) path = path.slice(1);
    if (path.endsWith("/")) path = path.slice(0, -1);

    const method = req.method ?? "GET";

    // -- unauthenticated --

    if (path === "version") {
      return json(res, {
        release: config.versionRelease,
        prerelease: config.versionPrerelease,
      });
    }

    if (path.startsWith("assets/")) {
      const assetPath = path.slice("assets/".length);
      const data = await assets.get(assetPath);
      if (data === null) return text(res, 404, "asset not found");
      return raw(res, 200, mimeFor(assetPath), data);
    }

    if (path === "auth/id") {
      if (!config.sessionAuthEnabled) return text(res, 403, "session auth disabled");
      const username = url.searchParams.get("username");
      if (!username) return text(res, 400, "no username");
      return text(res, 200, sessionAuth.newServerId(username));
    }

    if (path === "auth/verify") {
      if (!config.sessionAuthEnabled) return text(res, 403, "session auth disabled");
      const id = url.searchParams.get("id");
      if (!id) return text(res, 400, "no id");
      const token = await sessionAuth.verify(id, config, tokens);
      if (token === null) return text(res, 401, "verification failed");

      // Worth shouting about: only an unmodified client takes this path, and an unmodified
      // client still has Figura's v4-UUID filter — it will never load an offline player's
      // avatar no matter what the backend does.
      const who = tokens.verify(token);
      log(`[auth] ${who?.name ?? "?"} authenticated through Mojang — this client is NOT the `
        + `fork, so it will not see offline players' avatars`);
      return text(res, 200, token);
    }

    // -- everything below needs a token --

    if (path.startsWith("admin/")) {
      return admin(req, res, path.slice("admin/".length), deps);
    }

    const header = req.headers["token"];
    const me = tokens.verify(Array.isArray(header) ? header[0] : header);
    if (me === null) return text(res, 401, "unauthorized");

    // Any authenticated request means this player is still around, so their avatars are
    // not garbage. Throttled inside the store; deliberately not awaited.
    void avatars.touch(me.uuid);

    if (path === "") return text(res, 200, "ok"); // checkAuth
    if (path === "limits") return limits(res, me, config);
    if (path === "motd") return motd(res, config);

    if (path === "equip" && method === "POST") {
      return equip(req, res, me, avatars, users, hub, log, recentUploads);
    }

    const parts = path.split("/");

    if (method === "GET" && parts.length === 1 && UUID_RE.test(parts[0]!)) {
      return profile(res, parts[0]!.toLowerCase(), avatars, users, config);
    }

    if (method === "GET" && parts.length === 2 && UUID_RE.test(parts[0]!)) {
      const data = await avatars.load(parts[0]!.toLowerCase(), parts[1]!);
      if (data === null) return text(res, 404, "avatar not found");
      return raw(res, 200, "application/octet-stream", data);
    }

    if (method === "PUT" && parts.length === 1) {
      return upload(req, res, me, parts[0]!, avatars, hub, config, recentUploads);
    }

    if (method === "DELETE" && parts.length === 1) {
      const deleted = await avatars.delete(me.uuid, parts[0]!);
      if (!deleted) return text(res, 404, "avatar not found");
      await users.unequipAll(me.uuid, parts[0]!);
      hub.broadcastAvatarChanged(me.uuid);
      return text(res, 200, "ok");
    }

    return text(res, 404, "not found");
  };
}

// -- admin --

/**
 * Maintenance routes, guarded by their own token so they are nothing like a player token.
 * Disabled entirely when FIGURA_ADMIN_TOKEN is empty.
 */
async function admin(
  req: IncomingMessage,
  res: ServerResponse,
  action: string,
  deps: ApiDeps,
): Promise<void> {
  const { config, avatars, users, log } = deps;

  if (config.adminToken === "") return text(res, 404, "not found");

  const header = req.headers["admin-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (provided !== config.adminToken) return text(res, 401, "unauthorized");

  if (action === "logs" && req.method === "GET") {
    // Mirrored into the Minecraft server console by the FiguraLink plugin.
    const url = new URL(req.url ?? "/", "http://localhost");
    const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const page = deps.logs.after(Number.isFinite(since) ? since : 0,
                                 Number.isFinite(limit) ? limit : 100);
    return json(res, page);
  }

  if (action === "stats" && req.method === "GET") {
    const stats = await avatars.stats();
    return json(res, stats);
  }

  if (action === "sweep" && req.method === "POST") {
    const result = await runSweep(deps);
    return json(res, result);
  }

  if (action.startsWith("purge/") && req.method === "POST") {
    const uuid = action.slice("purge/".length).toLowerCase();
    if (!UUID_RE.test(uuid)) return text(res, 400, "not a uuid");

    const removed = await avatars.purge(uuid);
    await users.forget(uuid);
    // Somebody else may have been wearing that avatar.
    for (const id of ["avatar"]) await users.unequipAll(uuid, id);
    deps.hub.broadcastAvatarChanged(uuid);

    log(`[admin] purged ${uuid}: ${removed} avatar(s)`);
    return json(res, { uuid, removed });
  }

  return text(res, 404, "not found");
}

/** Shared by the scheduled cleanup and the admin endpoint. */
export async function runSweep(deps: ApiDeps): Promise<{
  owners: number; files: number; bytes: number;
}> {
  const { config, avatars, users, hub, log } = deps;
  const maxAge = config.cleanupInactiveDays * 24 * 60 * 60 * 1000;

  const result = await avatars.sweep(maxAge);
  for (const owner of result.owners) {
    await users.forget(owner);
    hub.broadcastAvatarChanged(owner);
  }

  if (result.files > 0) {
    log(`[cleanup] removed ${result.files} file(s), ${result.bytes} bytes, `
      + `${result.owners.length} player(s) inactive for over ${config.cleanupInactiveDays} days`);
  }
  return { owners: result.owners.length, files: result.files, bytes: result.bytes };
}

// -- endpoints --

function limits(res: ServerResponse, me: Session, config: Config): void {
  const max = Math.min(me.limits.maxAvatarSize, config.maxAvatarSizeCeiling);
  json(res, {
    rate: {
      upload: me.limits.uploadRate || config.uploadRate,
      download: me.limits.downloadRate || config.downloadRate,
    },
    limits: {
      maxAvatarSize: max,
      maxAvatars: me.limits.maxAvatars,
      allowedBadges: 0,
    },
  });
}

function motd(res: ServerResponse, config: Config): void {
  const value = config.motd.trim();
  // The client runs the body through a lenient JSON-component parser, so a plain string is
  // fine — but quote it so the response is valid JSON either way.
  const body = value.startsWith("{") || value.startsWith("[") ? value : JSON.stringify(value);
  raw(res, 200, "application/json", Buffer.from(body, "utf8"));
}

async function profile(
  res: ServerResponse,
  target: string,
  avatars: AvatarStore,
  users: UserStore,
  config: Config,
): Promise<void> {
  const equipped: Array<{ owner: string; id: string; hash: string }> = [];
  for (const entry of await users.equipped(target)) {
    const hash = await avatars.hash(entry.owner, entry.id);
    if (hash === null) continue; // avatar was deleted out from under the profile
    equipped.push({ owner: entry.owner, id: entry.id, hash });
  }

  const badges = await users.badges(target);

  json(res, {
    uuid: target,
    rank: "default",
    lastUsed: Date.now(),
    banned: false,
    version: config.versionRelease,
    equipped,
    equippedBadges: { pride: badges.pride, special: badges.special },
  });
}

async function upload(
  req: IncomingMessage,
  res: ServerResponse,
  me: Session,
  id: string,
  avatars: AvatarStore,
  hub: WsHub,
  config: Config,
  recentUploads: Map<string, number>,
): Promise<void> {
  if (!AvatarStore.validId(id)) return text(res, 400, "bad avatar id");

  const max = Math.min(me.limits.maxAvatarSize, config.maxAvatarSizeCeiling);

  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (!Number.isFinite(declared)) return text(res, 400, "missing content-length");
  // Reject on the declared size before reading, so an oversized upload costs no memory.
  if (declared > max) return text(res, 400, "avatar too big");

  const body = await readBody(req, max);
  if (body === null) return text(res, 400, "avatar too big");

  if (!(await avatars.exists(me.uuid, id)) && (await avatars.count(me.uuid)) >= me.limits.maxAvatars) {
    return text(res, 403, "avatar limit reached");
  }

  await avatars.save(me.uuid, id, body);
  recentUploads.set(me.uuid, Date.now());
  hub.broadcastAvatarChanged(me.uuid);
  text(res, 200, "ok");
}

async function equip(
  req: IncomingMessage,
  res: ServerResponse,
  me: Session,
  avatars: AvatarStore,
  users: UserStore,
  hub: WsHub,
  log: (message: string) => void,
  recentUploads: Map<string, number>,
): Promise<void> {
  const body = await readBody(req, 64 * 1024);
  if (body === null) return text(res, 400, "body too big");

  const equipped: Equipped[] = [];
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Array<{ owner: string; id: string }>;
    for (const entry of parsed) {
      const owner = String(entry.owner).toLowerCase();
      const id = String(entry.id);
      if (!UUID_RE.test(owner) || !AvatarStore.validId(id)) {
        log(`[equip] ${me.uuid} sent a malformed entry (owner=${entry.owner} id=${entry.id})`);
        continue;
      }

      if (await avatars.exists(owner, id)) {
        equipped.push({ owner, id });
        continue;
      }

      // Right after uploading, the client equips what it just sent using the owner UUID it
      // believes it has — which comes from whatever it thought the local player was when
      // the avatar was loaded. That can disagree with the UUID the game server assigned,
      // most visibly for offline players whose launcher UUID has nothing to do with the
      // offline one derived from their nickname. The upload itself landed under the token's
      // UUID, so the entry points at nothing and the player ends up wearing nothing.
      //
      // Scoped to the seconds right after that player's own upload on purpose: outside that
      // window, asking for an avatar that does not exist is just a bad request, and quietly
      // swapping in their own would be wrong.
      const uploadedAt = recentUploads.get(me.uuid) ?? 0;
      const justUploaded = Date.now() - uploadedAt < SELF_EQUIP_WINDOW_MS;

      if (justUploaded && owner !== me.uuid && (await avatars.exists(me.uuid, id))) {
        log(`[equip] ${me.uuid} asked for ${owner}/${id} which does not exist; `
          + `using their own ${id} instead (client and server disagree on the local UUID)`);
        equipped.push({ owner: me.uuid, id });
        continue;
      }

      log(`[equip] ${me.uuid} asked for ${owner}/${id}, which does not exist — dropped`);
    }
  } catch {
    return text(res, 400, "bad json");
  }

  await users.setEquipped(me.uuid, equipped);
  hub.broadcastAvatarChanged(me.uuid);
  text(res, 200, "ok");
}

// -- plumbing --

/** Reads the request body, bailing out as soon as it exceeds `max` bytes. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) {
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function text(res: ServerResponse, status: number, body: string): void {
  raw(res, status, "text/plain; charset=utf-8", Buffer.from(body, "utf8"));
}

function json(res: ServerResponse, body: unknown): void {
  raw(res, 200, "application/json", Buffer.from(JSON.stringify(body), "utf8"));
}

function raw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
  });
  res.end(body);
}
