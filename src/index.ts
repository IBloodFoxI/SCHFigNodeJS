import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import { createApiHandler, runSweep } from "./http/api.js";
import { AssetCache } from "./stores/assets.js";
import { AvatarStore } from "./stores/avatars.js";
import { UserStore } from "./stores/users.js";
import { TokenVerifier } from "./tokens.js";
import { WsHub } from "./ws/hub.js";

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const tokens = new TokenVerifier(config.secret);
  const avatars = new AvatarStore(path.join(config.dataDir, "avatars"));
  const users = new UserStore(path.join(config.dataDir, "users"));
  const assets = new AssetCache(
    path.join(config.dataDir, "assets"),
    config.assetsProxy,
    config.assetsUpstream,
  );
  await Promise.all([avatars.init(), users.init(), assets.init()]);

  const hub = new WsHub(tokens, config.debug, log);
  const deps = { config, tokens, avatars, users, assets, hub, log };
  const handle = createApiHandler(deps);

  // A process killed mid-rename leaves *.tmp behind; clear them before serving.
  const strays = await avatars.cleanTemp();
  if (strays > 0) log(`removed ${strays} leftover temp file(s)`);

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`[http] unhandled error on ${req.url}: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  });

  // Same port as the API: the client builds both URLs from one configured address.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws));
  });

  const keepAlive =
    config.wsKeepaliveSeconds > 0
      ? setInterval(() => hub.keepAlive(), config.wsKeepaliveSeconds * 1000)
      : null;
  keepAlive?.unref();

  let cleanup: NodeJS.Timeout | null = null;
  if (config.cleanupEnabled) {
    const run = (): void => {
      runSweep(deps).catch((error: unknown) => log(`[cleanup] failed: ${String(error)}`));
    };
    cleanup = setInterval(run, config.cleanupIntervalHours * 60 * 60 * 1000);
    cleanup.unref();
    // Once shortly after boot too, so a long-stopped instance catches up.
    setTimeout(run, 60_000).unref();
    log(`cleanup on: avatars untouched for ${config.cleanupInactiveDays} days are removed `
      + `every ${config.cleanupIntervalHours}h`);
  }

  server.listen(config.port, config.host, () => {
    log(`Figura backend listening on http://${config.host}:${config.port}`);
    log("TLS is terminated upstream — the Figura client only speaks https/wss, so a "
      + "reverse proxy must sit in front of this port.");
  });

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`);
    if (keepAlive) clearInterval(keepAlive);
    if (cleanup) clearInterval(cleanup);
    hub.closeAll();
    server.close(() => process.exit(0));
    // Do not let a wedged connection hold the container hostage.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  process.exit(1);
});
