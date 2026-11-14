/**
 * 标签扫描：日期窗口切片 + offset 5000 上限处理 + 超限日双向枚举 + 游标续跑。
 *
 * 索引：feasibility §3.8 / plan §9.2。
 */

import { addDays, dayOf, sleep } from './common.mjs';

const OFFSET_LIMIT = 4500;
const PAGE_SIZE = 30;

function cursorKey(word, opts) {
  return [word, opts.exact ? 'exact' : 'partial', opts.sort ?? 'date', opts.type, opts.r18, opts.ai, opts.since ?? '', opts.until ?? ''].join('|');
}

async function scanWindow(api, {
  word,
  start,
  end,
  sort,
  searchParams,
  offset = 0,
  maxPages = 200,
  onPage,
} = {}) {
  const items = [];
  let pages = 0;
  let capped = false;
  let limited = false;
  for (;;) {
    const params = { ...searchParams, word, offset };
    if (sort === 'date_asc') params.sort = 'date_asc';
    if (start) params.start_date = start;
    if (end) params.end_date = end;
    const j = await api.search(params);
    const list = j.illusts ?? [];
    items.push(...list);
    pages++;
    offset += PAGE_SIZE;
    await onPage?.({ offset, pages });
    if (!j.next_url) break;
    if (offset >= OFFSET_LIMIT) {
      capped = true;
      break;
    }
    if (pages >= maxPages) {
      limited = true;
      break;
    }
  }
  return {
    items,
    pages,
    capped,
    limited,
    firstDate: items[0]?.create_date,
    lastDate: items.at(-1)?.create_date,
  };
}

/**
 * 逐标签产出候选作品（未过滤，调用方负责过滤/去重/下载）。
 * @returns {AsyncGenerator<object>}
 */
export async function* scanTag(api, { word, opts, state, log, seen }) {
  const key = cursorKey(word, opts);
  const cursor = state.getCursor(key);
  let start = cursor?.start ?? opts.since ?? null;
  let end = cursor?.end ?? opts.until ?? null;
  let offset = cursor?.offset ?? 0;
  let loops = 0;

  if (!end) throw new Error('内部错误：until 未设置');

  while (true) {
    if (++loops > 5000) throw new Error('扫描窗口循环次数异常，已中止（可能是 API 行为变化）');

    const desc = await scanWindow(api, {
      word,
      start,
      end,
      sort: 'date_desc',
      searchParams: opts.searchParams,
      offset,
      maxPages: opts.maxPages,
      onPage: async ({ offset: nextOffset, pages }) => {
        state.setCursor(key, { start, end, offset: nextOffset });
        log?.verbose?.(`[${word}] 扫描 ${start ?? '最早'} ~ ${end}，第 ${pages} 页（offset ${nextOffset - PAGE_SIZE}）`);
      },
    });

    for (const work of desc.items) {
      if (seen.has(String(work.id))) continue;
      seen.add(String(work.id));
      yield work;
    }

    if (!desc.capped) break; // 窗口扫完

    if (desc.limited) {
      log?.warn?.(`[${word}] 达到 --max-pages 限制，停止该标签（可重跑续扫）`);
      return;
    }

    const lastDay = dayOf(String(desc.lastDate ?? end));

    if (start === lastDay) {
      // 单日仍触顶：反向枚举 + 边界时间戳校验
      log?.warn?.(`[${word}] ${lastDay} 单日超过 offset 上限，尝试 date_asc 反向枚举`);
      const asc = await scanWindow(api, {
        word,
        start: lastDay,
        end: lastDay,
        sort: 'date_asc',
        searchParams: opts.searchParams,
        offset: 0,
        maxPages: opts.maxPages,
      });
      for (const work of asc.items) {
        if (seen.has(String(work.id))) continue;
        seen.add(String(work.id));
        yield work;
      }
      const ascNewest = asc.lastDate ? new Date(asc.lastDate) : null;
      const descOldest = desc.lastDate ? new Date(desc.lastDate) : null;
      if (ascNewest && descOldest && ascNewest < descOldest) {
        log?.warn?.(`[${word}] ${lastDay} 覆盖不完整：asc 最新 ${asc.lastDate} 早于 desc 最旧 ${desc.lastDate}（单日可见作品可能 > 10000）`);
      } else {
        log?.verbose?.(`[${word}] ${lastDay} 双向枚举边界已接上`);
      }
      end = addDays(lastDay, -1);
      start = opts.since ?? null;
      offset = 0;
      if (opts.since && end < opts.since) break;
      continue;
    }

    // 缩小窗口：若上限恰好落在窗口末日，则收窄到该单日；否则把 end 移到该日
    if (end === lastDay) start = lastDay;
    else end = lastDay;
    offset = 0;
    await sleep(200);
  }
}
