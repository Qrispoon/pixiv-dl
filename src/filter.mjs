/**
 * 过滤规则：收藏数 / 类型 / R-18 / AI。
 */

export function passesFilter(work, opts) {
  const bookmarks = Number(work.total_bookmarks ?? 0);
  if (bookmarks < (opts.minBookmarks ?? 0)) return false;
  if (opts.maxBookmarks != null && bookmarks > opts.maxBookmarks) return false;

  if (opts.type && opts.type !== 'all') {
    const t = work.type === 'ugoira' ? 'illust' : work.type;
    if (t !== opts.type) return false;
  }

  const xr = Number(work.x_restrict ?? 0);
  if (opts.r18 === 'exclude' && xr !== 0) return false;
  if (opts.r18 === 'only' && xr === 0) return false;

  const ai = Number(work.illust_ai_type ?? 0);
  if (opts.ai === 'exclude' && ai === 2) return false;
  if (opts.ai === 'only' && ai !== 2) return false;

  return true;
}

export function searchParamsFor(opts) {
  const params = {
    search_target: opts.exact ? 'exact_match_for_tags' : 'partial_match_for_tags',
    sort: opts.sort === 'popular' ? 'popular_desc' : 'date_desc',
    filter: opts.r18 === 'exclude' ? 'for_ios' : '',
  };
  if (opts.ai === 'exclude') params.search_ai_type = 0;
  return params;
}
