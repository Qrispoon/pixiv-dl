/**
 * 状态：输出目录下的 .pixivdl/。
 *
 *   state.jsonl   每行一个已完成作品 {pid, files, bookmarks, artist, ts}
 *   cursors.json  每个标签的扫描进度 {start,end,offset,updated_at}
 *   failed.jsonl  失败清单（供 retry 使用，M1 只记录）
 *   lock          防并发（6 小时后视为 stale）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export class State {
  constructor(outDir, { force = false, noResume = false, readonly = false } = {}) {
    this.dir = join(outDir, '.pixivdl');
    this.stateFile = join(this.dir, 'state.jsonl');
    this.cursorFile = join(this.dir, 'cursors.json');
    this.failedFile = join(this.dir, 'failed.jsonl');
    this.lockFile = join(this.dir, 'lock');
    this.force = force;
    this.noResume = noResume;
    this.readonly = readonly; // dry-run 时不创建目录、不写状态
    this.done = new Set();
    this.cursors = {};
    if (!readonly) mkdirSync(this.dir, { recursive: true });
  }

  acquireLock() {
    if (existsSync(this.lockFile)) {
      try {
        const info = JSON.parse(readFileSync(this.lockFile, 'utf8'));
        const alive = Number.isFinite(info.pid) ? (() => {
          try {
            process.kill(info.pid, 0);
            return true;
          } catch {
            return false;
          }
        })() : false;
        const age = Date.now() - (info.started_at ?? 0);
        if (alive && age < LOCK_STALE_MS) {
          throw new Error(`输出目录已有另一个 ptdl 在运行（pid ${info.pid}）。确认无进程后可删除 ${this.lockFile}`);
        }
      } catch (e) {
        if (String(e.message).includes('已有另一个')) throw e;
      }
    }
    writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
  }

  releaseLock() {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* ignore */
    }
  }

  load() {
    if (existsSync(this.stateFile)) {
      for (const line of readFileSync(this.stateFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item?.pid != null) this.done.add(String(item.pid));
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
    if (existsSync(this.cursorFile)) {
      try {
        this.cursors = JSON.parse(readFileSync(this.cursorFile, 'utf8'));
      } catch {
        this.cursors = {};
      }
    }
    return this;
  }

  isDone(pid) {
    return !this.force && this.done.has(String(pid));
  }

  markDone(work, files) {
    if (this.readonly) return;
    const pid = String(work.id);
    this.done.add(pid);
    appendFileSync(
      this.stateFile,
      JSON.stringify({
        pid,
        bookmarks: work.total_bookmarks ?? 0,
        artist: work.user?.name ?? '',
        type: work.type ?? '',
        files,
        ts: new Date().toISOString(),
      }) + '\n',
    );
  }

  addFailed(entry) {
    if (this.readonly) return;
    appendFileSync(this.failedFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
  }

  getCursor(key) {
    return this.noResume ? null : this.cursors[key] ?? null;
  }

  setCursor(key, cursor) {
    if (this.readonly) return;
    this.cursors[key] = { ...cursor, updated_at: new Date().toISOString() };
    const tmp = `${this.cursorFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cursors, null, 1));
    renameSync(tmp, this.cursorFile);
  }

  stats() {
    return { done: this.done.size, cursors: Object.keys(this.cursors).length };
  }

  fileSize() {
    try {
      return statSync(this.stateFile).size;
    } catch {
      return 0;
    }
  }
}
