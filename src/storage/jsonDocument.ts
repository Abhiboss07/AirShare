/**
 * Atomic JSON document.
 *
 * Purpose: a tiny building block for the file-backed repositories. Reads a JSON
 * file into memory and writes it back atomically (temp file + rename) so a
 * crash mid-write can never corrupt the store. Optional restrictive file mode
 * protects secrets like the private key.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export class JsonDocument<T> {
  private cache: T | undefined;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
    private readonly mode = 0o600,
  ) {}

  async read(): Promise<T> {
    if (this.loaded) return this.cache as T;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = this.fallback;
      } else {
        throw error;
      }
    }
    this.loaded = true;
    return this.cache as T;
  }

  async write(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(value, null, 2);
    await fs.writeFile(tmp, data, { mode: this.mode });
    await fs.rename(tmp, this.filePath);
    this.cache = value;
    this.loaded = true;
  }

  /** Read-modify-write helper that keeps the in-memory cache coherent. */
  async update(mutator: (current: T) => T): Promise<T> {
    const current = await this.read();
    const next = mutator(current);
    await this.write(next);
    return next;
  }
}
