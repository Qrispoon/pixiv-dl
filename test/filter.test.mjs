import test from 'node:test';
import assert from 'node:assert/strict';
import { passesFilter, searchParamsFor } from '../src/filter.mjs';

const base = {
  id: 1,
  type: 'illust',
  total_bookmarks: 1500,
  x_restrict: 0,
  illust_ai_type: 1,
  user: { id: 1, name: 'a' },
};

const opts = { minBookmarks: 1000, maxBookmarks: null, type: 'all', r18: 'exclude', ai: 'include' };

test('收藏数下限', () => {
  assert.equal(passesFilter(base, opts), true);
  assert.equal(passesFilter({ ...base, total_bookmarks: 999 }, opts), false);
});

test('R-18 过滤', () => {
  assert.equal(passesFilter({ ...base, x_restrict: 1 }, opts), false);
  assert.equal(passesFilter({ ...base, x_restrict: 1 }, { ...opts, r18: 'only' }), true);
  assert.equal(passesFilter({ ...base, x_restrict: 0 }, { ...opts, r18: 'only' }), false);
});

test('AI 过滤', () => {
  assert.equal(passesFilter({ ...base, illust_ai_type: 2 }, opts), true);
  assert.equal(passesFilter({ ...base, illust_ai_type: 2 }, { ...opts, ai: 'exclude' }), false);
  assert.equal(passesFilter({ ...base, illust_ai_type: 1 }, { ...opts, ai: 'only' }), false);
});

test('类型过滤', () => {
  assert.equal(passesFilter({ ...base, type: 'manga' }, { ...opts, type: 'illust' }), false);
});

test('搜索参数映射', () => {
  const p = searchParamsFor({ exact: true, sort: 'date', r18: 'exclude', ai: 'exclude' });
  assert.equal(p.search_target, 'exact_match_for_tags');
  assert.equal(p.filter, 'for_ios');
  assert.equal(p.search_ai_type, 0);
});
