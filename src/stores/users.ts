import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Equipped {
  owner: string;
  id: string;
}

interface Profile {
  equipped: Equipped[];
  badges: { pride: number[]; special: number[] };
}

/**
 * What each player currently wears: {@code users/<uuid>.json}. Kept apart from the avatar
 * blobs so equipping never rewrites megabytes.
 */
export class UserStore {
  readonly #root: string;
  readonly #cache = new Map<string, Profile>();

  constructor(root: string) {
    this.#root = root;
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  #file(uuid: string): string {
    return path.join(this.#root, `${uuid}.json`);
  }

  async #profile(uuid: string): Promise<Profile> {
    const cached = this.#cache.get(uuid);
    if (cached !== undefined) return cached;

    let profile: Profile = { equipped: [], badges: { pride: [], special: [] } };
    try {
      const parsed = JSON.parse(await readFile(this.#file(uuid), "utf8")) as Partial<Profile>;
      profile = {
        equipped: Array.isArray(parsed.equipped) ? parsed.equipped : [],
        badges: {
          pride: parsed.badges?.pride ?? [],
          special: parsed.badges?.special ?? [],
        },
      };
    } catch {
      // A corrupt profile costs the player their equipped list, not their avatars.
    }

    this.#cache.set(uuid, profile);
    return profile;
  }

  async equipped(uuid: string): Promise<Equipped[]> {
    return (await this.#profile(uuid)).equipped;
  }

  async badges(uuid: string): Promise<{ pride: number[]; special: number[] }> {
    return (await this.#profile(uuid)).badges;
  }

  async setEquipped(uuid: string, equipped: Equipped[]): Promise<void> {
    const profile = await this.#profile(uuid);
    profile.equipped = equipped;
    await this.#save(uuid, profile);
  }

  /** Drops any equipped entry pointing at the given avatar (used after a delete). */
  async unequipAll(owner: string, id: string): Promise<void> {
    for (const [uuid, profile] of this.#cache) {
      const filtered = profile.equipped.filter((e) => !(e.owner === owner && e.id === id));
      if (filtered.length !== profile.equipped.length) {
        profile.equipped = filtered;
        await this.#save(uuid, profile);
      }
    }
  }

  /** Forgets a player entirely: cached profile and the file behind it. */
  async forget(uuid: string): Promise<void> {
    this.#cache.delete(uuid);
    try {
      await rm(this.#file(uuid), { force: true });
    } catch {
      // Never existed, which is the same outcome.
    }
  }

  async #save(uuid: string, profile: Profile): Promise<void> {
    const file = this.#file(uuid);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(profile, null, 2), "utf8");
    await rename(tmp, file);
  }
}
