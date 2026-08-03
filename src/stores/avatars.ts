import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Avatars on disk: {@code avatars/<owner-uuid>/<id>.moon}. The bytes are exactly what the
 * client uploaded (gzipped NBT) — we never parse them, only weigh and hash them.
 */
export class AvatarStore {
  readonly #root: string;
  /** "owner/id" -> sha256 hex, invalidated on write and delete. */
  readonly #hashes = new Map<string, string>();

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
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
