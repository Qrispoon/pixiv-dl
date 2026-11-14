import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';

test('State：markDone/isDone、游标、只读模式', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptdl-state-'));
  try {
    const s = new State(dir).load();
    s.acquireLock();
    assert.equal(s.isDone(123), false);
    s.markDone({ id: 123, total_bookmarks: 9, user: { name: 'a' }, type: 'illust' }, ['a.png']);
    assert.equal(s.isDone(123), true);

    s.setCursor('tag', { start: '2024-01-01', end: '2024-01-02', offset: 30 });
    const s2 = new State(dir).load();
    assert.deepEqual(s2.getCursor('tag').offset, 30);
    assert.equal(s2.isDone(123), true);
    s.releaseLock();

    const ro = new State(dir, { force: true }).load();
    ro.readonly = true;
    ro.markDone({ id: 999 }, ['x']);
    ro.setCursor('other', { offset: 60 });
    assert.equal(new State(dir).load().isDone(999), false);
    assert.equal(ro.getCursor('other'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
