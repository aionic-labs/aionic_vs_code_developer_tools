import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export class Snapshot {
  constructor(
    readonly hash: string,
    private readonly filename: string,
  ) {}

  read(): string {
    return readFileSync(this.filename, 'utf8');
  }

  matches(text: string): boolean {
    return this.hash === digest(text);
  }
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Immutable local blobs keep unchanged source contents out of extension-host memory. */
export class SnapshotStore {
  private initialized?: Promise<unknown>;
  private readonly saved = new Set<string>();

  constructor(private readonly directory: string) {}

  load(hash: string): Snapshot {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Invalid inline review snapshot identifier');
    }
    return new Snapshot(hash, path.join(this.directory, hash));
  }

  async save(text: string): Promise<Snapshot> {
    const hash = digest(text);
    await (this.initialized ??= mkdir(this.directory, {recursive: true}));
    if (!this.saved.has(hash)) {
      const temporary = path.join(this.directory, `${hash}.${randomUUID()}.tmp`);
      await writeFile(temporary, text, {mode: 0o600});
      await rename(temporary, path.join(this.directory, hash));
      this.saved.add(hash);
    }
    return this.load(hash);
  }
}
