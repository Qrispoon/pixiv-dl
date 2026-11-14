import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, renderName, artistName } from '../src/naming.mjs';

const work = {
  id: 100412238,
  total_bookmarks: 11247,
  title: 'Test / Title',
  create_date: '2022-08-11T23:46:14+09:00',
  user: { id: 47196062, name: '360', account: '360px' },
};

test('sanitizeName 处理 Windows 非法字符与保留名', () => {
  assert.equal(sanitizeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(sanitizeName('  trailing.  '), 'trailing');
  assert.equal(sanitizeName('CON'), 'CON_');
  assert.equal(sanitizeName(''), '');
});

test('默认命名 {artist}-{id}-{bookmarks}', () => {
  assert.equal(renderName('{artist}-{id}-{bookmarks}', work, { page: 0, pageCount: 1, ext: '.png' }), '360-100412238-11247.png');
});

test('多页带 _p{n}', () => {
  assert.equal(renderName('{artist}-{id}-{bookmarks}', work, { page: 2, pageCount: 4, ext: '.jpg' }), '360-100412238-11247_p2.jpg');
});

test('动图带 _ugoira', () => {
  assert.equal(renderName('{artist}-{id}-{bookmarks}', work, { ugoira: true }), '360-100412238-11247_ugoira');
});

test('画师名缺失回退 user_id', () => {
  assert.equal(artistName({ user: { id: 42, name: '' } }), 'user_42');
});
