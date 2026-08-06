import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Avatars on disk: {@code avatars/<owner-uuid>/<id>.moon}. The bytes are exactly what the
 * client uploaded (gzipped NBT) — we never parse them, only weigh and hash them.
 */
export class AvatarStore {
  readonly #root: string;
  /** "owner/id" -> sha256 hex, invalidated on write and delete. */
  readonly #hashes = new Map<string, string>();
  /** owner -> when we last bumped their mtimes, so touch() stays cheap. */
  readonly #touched = new Map<string, number>();

  constructor(root: string) {
    this.#root = root;
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  static validId(id: string): boolean {
    return /^[A-Za-z0-9_.-]{1,64}$/.test(id);
  }

  #file(owner: string, id: string): string {
    return path.join(this.#root, owner, `${id}.moon`);
  }

  async load(owner: string, id: string): Promise<Buffer | null> {
    if (!AvatarStore.validId(id)) return null;
    try {
      return await readFile(this.#file(owner, id));
    } catch {
      return null;
    }
  }

  async exists(owner: string, id: string): Promise<boolean> {
    return (await this.load(owner, id)) !== null;
  }

  async save(owner: string, id: string, data: Buffer): Promise<void> {
    if (!AvatarStore.validId(id)) throw new Error(`illegal avatar id: ${id}`);
    const file = this.#file(owner, id);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    this.#hashes.set(`${owner}/${id}`, sha256(data));
  }

  async delete(owner: string, id: string): Promise<boolean> {
    if (!AvatarStore.validId(id)) return false;
    this.#hashes.delete(`${owner}/${id}`);
    try {
      await rm(this.#file(owner, id));
      return true;
    } catch {
      return false;
    }
  }

  /** Hash the client uses as its local cache key. Null when the avatar is gone. */
  async hash(owner: string, id: string): Promise<string | null> {
    const key = `${owner}/${id}`;
    const cached = this.#hashes.get(key);
    if (cached !== undefined) return cached;

    const data = await this.load(owner, id);
    if (data === null) return null;

    const hash = sha256(data);
    this.#hashes.set(key, hash);
    return hash;
  }

  async list(owner: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.#root, owner));
      return entries
        .filter((name) => name.endsWith(".moon"))
        .map((name) => name.slice(0, -".moon".length));
    } catch {
      return [];
    }
  }

  async count(owner: string): Promise<number> {
    return (await this.list(owner)).length;
  }

  /**
   * Marks the owner as still around, by bumping the mtime of their avatars.
   *
   * <p>Called whenever a valid token for that UUID shows up. Download time would be the
   * wrong signal: clients cache avatars by hash, so an active player's file can go
   * untouched for weeks while they play every day.
   *
   * <p>Throttled to once an hour per player — this runs on every authenticated request.
   */
  async touch(owner: string): Promise<void> {
    const now = Date.now();
    const last = this.#touched.get(owner);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
    this.#touched.set(owner, now);

    const when = new Date(now);
    for (const id of await this.list(owner)) {
      try {
        await utimes(this.#file(owner, id), when, when);
      } catch {
        // Deleted between listing and touching; nothing to keep alive.
      }
    }
  }

  /** Deletes every avatar of one player. Returns how many files went. */
  async purge(owner: string): Promise<number> {
    let removed = 0;
    for (const id of await this.list(owner)) {
      if (await this.delete(owner, id)) removed += 1;
    }
    this.#touched.delete(owner);
    try {
      await rm(path.join(this.#root, owner), { recursive: true, force: true });
    } catch {
      // Directory already gone or not empty because of a concurrent upload.
    }
    return removed;
  }

  /**
   * Drops avatars nobody has touched in `maxAgeMs`, plus any leftover temp files.
   * Returns the owners whose avatars were removed, so callers can tidy up profiles.
   */
  async sweep(maxAgeMs: number): Promise<{ owners: string[]; files: number; bytes: number }> {
    const cutoff = Date.now() - maxAgeMs;
    const owners: string[] = [];
    let files = 0;
    let bytes = 0;

    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return { owners, files, bytes };
    }

    for (const owner of entries) {
      const dir = path.join(this.#root, owner);
      let contents: string[];
      try {
        contents = await readdir(dir);
      } catch {
        continue;
      }

      let removedHere = 0;
      let survivors = 0;

      for (const name of contents) {
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          if (!info.isFile()) continue;

          // Leftovers from a write that was interrupted mid-rename.
          if (name.endsWith(".tmp")) {
            await rm(file, { force: true });
            files += 1;
            bytes += info.size;
            continue;
          }
          if (!name.endsWith(".moon")) continue;

          if (info.mtimeMs < cutoff) {
            const id = name.slice(0, -".moon".length);
            if (await this.delete(owner, id)) {
              removedHere += 1;
              files += 1;
              bytes += info.size;
            }
          } else {
            survivors += 1;
          }
        } catch {
          // Raced with an upload or a delete; it will be caught next sweep.
        }
      }

      if (removedHere > 0) owners.push(owner);
      if (survivors === 0) {
        this.#touched.delete(owner);
        try {
          await rm(dir, { recursive: false, force: false });
        } catch {
          // Still holds something (a .tmp being written right now) — leave it.
        }
      }
    }

    return { owners, files, bytes };
  }

  /** Removes stray *.tmp files left behind by a process that died mid-write. */
  async cleanTemp(): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return 0;
    }

    for (const owner of entries) {
      const dir = path.join(this.#root, owner);
      try {
        for (const name of await readdir(dir)) {
          if (!name.endsWith(".tmp")) continue;
          await rm(path.join(dir, name), { force: true });
          removed += 1;
        }
      } catch {
        // Not a directory, or vanished.
      }
    }
    return removed;
  }

  async stats(): Promise<{ owners: number; files: number; bytes: number }> {
    let owners = 0;
    let files = 0;
    let bytes = 0;

    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return { owners, files, bytes };
    }

    for (const owner of entries) {
      let counted = false;
      try {
        for (const name of await readdir(path.join(this.#root, owner))) {
          if (!name.endsWith(".moon")) continue;
          const info = await stat(path.join(this.#root, owner, name));
          files += 1;
          bytes += info.size;
          counted = true;
        }
      } catch {
        continue;
      }
      if (counted) owners += 1;
    }

    return { owners, files, bytes };
  }
}

const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
