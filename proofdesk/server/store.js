// JSON 文件持久化：全量读入内存，写时走串行队列 + 临时文件原子 rename。
// 零依赖、对单机校对台足够；数据目录可整体备份。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const EMPTY = {
  users: [],
  projects: [],
  segments: [],
  edits: [],
  resolutions: [],
  merges: [],
  events: [],
};

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    this._chain = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } else {
      await this.persist();
    }
    return this;
  }

  /** 串行执行一次读改写事务 */
  async mutate(fn) {
    const run = this._chain.then(async () => {
      const result = await fn(this.data);
      await this.persist();
      return result;
    });
    this._chain = run.catch(() => {});
    return run;
  }

  /** 只读快照（深拷贝，避免调用方误改） */
  snapshot() {
    return structuredClone(this.data);
  }

  async persist() {
    const tmp = join(dirname(this.file), `.${Date.now()}-${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.file);
  }
}

export const newId = () => randomUUID();
