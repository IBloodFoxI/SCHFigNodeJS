import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Badges, emojis and the other shared resources Figura pulls from {@code /api/assets/...}.
 * They are identical on every backend, so we fetch them from upstream once and serve them
 * from disk afterwards. With the proxy off, seed the directory by hand instead.
 */
export class AssetCache {
  readonly #root: string;
  readonly #proxy: boolean;
  readonly #upstream: string;

  constructor(root: string, proxy: boolean, upstream: string) {
    this.#root = root;
    this.#proxy = proxy;
    this.#upstream = upstream;
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  /**
   * @param assetPath the part after `/api/assets/`, e.g. `v2` or `v2/badges/x.png`
   */
  async get(assetPath: string): Promise<Buffer | null> {
    if (!isSafe(assetPath)) return null;

    const local = path.join(this.#root, ...assetPath.split("/"));
    try {
      return await readFile(local);
    } catch {
      // not cached yet
    }

    if (!this.#proxy) return null;

    try {
      const response = await fetch(`${this.#upstream}/assets/${assetPath}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;

      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(local), { recursive: true });
      const tmp = `${local}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, local);
      return body;
    } catch {
      return null;
    }
  }
}

/** Rejects traversal and absolute paths before they reach the filesystem. */
function isSafe(assetPath: string): boolean {
  if (!assetPath) return false;
  if (assetPath.startsWith("/") || assetPath.includes("..")) return false;
  if (assetPath.includes("\\") || assetPath.includes(":")) return false;
  if (assetPath.includes("\0")) return false;
  return true;
}

export function mimeFor(assetPath: string): string {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}
