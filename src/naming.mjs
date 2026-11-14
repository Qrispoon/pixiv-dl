/**
 * 文件名模板与 Windows 安全化。
 *
 * 默认：{artist}-{id}-{bookmarks}
 * 多页：{...}_p0、_p1…；动图：{...}_ugoira.gif
 */

const INVALID = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeName(name, maxLen = 60) {
  let s = String(name ?? '')
    .replace(INVALID, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s) return '';
  if (RESERVED.test(s)) s = `${s}_`;
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/g, '');
  return s;
}

export function artistName(work) {
  const name = work.user?.name;
  const cleaned = sanitizeName(name);
  if (cleaned) return cleaned;
  return `user_${work.user?.id ?? 'unknown'}`;
}

export function renderName(template, work, { page, pageCount = 1, ext = '', ugoira = false } = {}) {
  const vars = {
    artist: artistName(work),
    account: sanitizeName(work.user?.account),
    artist_id: String(work.user?.id ?? ''),
    id: String(work.id ?? ''),
    bookmarks: String(work.total_bookmarks ?? 0),
    title: sanitizeName(work.title, 40),
    date: String(work.create_date ?? '').slice(0, 10),
    page: page == null ? '' : String(page),
    ext: String(ext).replace(/^\./, ''),
  };
  let base = String(template)
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''))
    .replace(/[-_ ]{2,}/g, '-')
    .replace(/^[-_ ]+|[-_ ]+$/g, '');
  base = sanitizeName(base, 120);
  if (!base) base = `${vars.id}-${vars.bookmarks}`;

  if (ugoira) base = `${base}_ugoira`;
  else if (pageCount > 1 && page != null) base = `${base}_p${page}`;
  return base + (ext || '');
}
