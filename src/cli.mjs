/**
 * CLI：参数解析、子命令（download / retry / login / doctor）、汇总输出。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { REPO_ROOT, UserError, createLogger, isoDate } from './common.mjs';
import { getAuth } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { searchParamsFor, passesFilter } from './filter.mjs';
import { PixivApi } from './pixiv.mjs';
import { scanTag } from './scan.mjs';
import { State } from './state.mjs';
import { downloadWork } from './download.mjs';
import { renderName } from './naming.mjs';

const HELP = `pixiv-tag-dl (ptdl) —— 按标签 + 最低收藏数下载 Pixiv 作品

用法：
  ptdl download <标签...> [选项]
  ptdl retry [选项]                重试 failed.jsonl 里的失败项
  ptdl login [login.mjs 参数]
  ptdl doctor [probe.mjs 参数]
  ptdl --version

下载选项：
  -o, --out <dir>            输出目录（默认 ./downloads）
  -m, --min-bookmarks <n>    收藏数下限（默认 0）
      --max-bookmarks <n>    收藏数上限
  -n, --limit <n>            本次最多下载作品数
      --max-pages <n>        每个窗口最多搜索页数（默认 200）
      --since <YYYY-MM-DD>   起始日期
      --until <YYYY-MM-DD>   截止日期（默认今天）
      --sort <date|popular>  排序（popular 仅 Premium；非 Premium 自动回退 date）
      --exact                标签精确匹配
      --and                  多个标签合并为一次搜索（默认逐个搜索）
      --type <illust|manga|all>
      --r18 <exclude|include|only>
      --ai <exclude|include|only>
      --ugoira <gif|mp4|zip|skip>  动图交付（默认 gif；需 ffmpeg）
      --ugoira-width <px>    GIF/MP4 宽度（默认 540）
      --keep-ugoira-zip      转码后保留原始 zip
      --name <模板>          默认 {artist}-{id}-{bookmarks}
      --by-tag               每个标签建子目录
      --jobs <n>             下载并发（默认 2）
      --delay <秒>           App API 请求间隔（默认 2）
      --retries <n>          单请求重试次数（默认 5）
      --timeout <秒>         单请求超时（默认 60）
      --proxy <url>          HTTP(S) 代理（也可用 HTTPS_PROXY 环境变量）
      --dry-run              只打印候选，不下载/不写状态
      --force                忽略已完成记录重新下载
      --no-resume            忽略扫描游标
      --json                 结束时输出 JSON 汇总
  -v, --verbose              详细日志

retry 选项：与 download 相同的 -o/--jobs/--delay/--retries/--timeout/--proxy/--json/--dry-run，
以及过滤条件 -m/--max-bookmarks/--type/--r18/--ai/--ugoira（按当前收藏数重新判断）。

示例：
  ptdl download 初音ミク -m 1000 -o D:\\pixiv\\miku
  ptdl download 初音ミク アークナイツ -m 5000 --since 2024-01-01
  ptdl download 女の子 -m 10000 --max-pages 2 --limit 20 --dry-run
  ptdl retry -o D:\\pixiv\\miku
`;

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return 'unknown';
  }
}

function parseCli(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: 'string', short: 'o' },
      'min-bookmarks': { type: 'string', short: 'm' },
      'max-bookmarks': { type: 'string' },
      limit: { type: 'string', short: 'n' },
      'max-pages': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      sort: { type: 'string' },
      exact: { type: 'boolean' },
      and: { type: 'boolean' },
      type: { type: 'string' },
      r18: { type: 'string' },
      ai: { type: 'string' },
      ugoira: { type: 'string' },
      'ugoira-width': { type: 'string' },
      'keep-ugoira-zip': { type: 'boolean' },
      name: { type: 'string' },
      'by-tag': { type: 'boolean' },
      jobs: { type: 'string' },
      delay: { type: 'string' },
      retries: { type: 'string' },
      timeout: { type: 'string' },
      proxy: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      'no-resume': { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      config: { type: 'string' },
      version: { type: 'boolean', short: 'V' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

const toNum = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError(`--${name} 需要数字，收到：${v}`, 2);
  return n;
};

function cliToConfig(values) {
  const out = {};
  const map = {
    out: 'out',
    'min-bookmarks': 'minBookmarks',
    'max-bookmarks': 'maxBookmarks',
    limit: 'limit',
    'max-pages': 'maxPages',
    since: 'since',
    until: 'until',
    sort: 'sort',
    exact: 'exact',
    and: 'and',
    type: 'type',
    r18: 'r18',
    ai: 'ai',
    ugoira: 'ugoira',
    'ugoira-width': 'ugoiraWidth',
    'keep-ugoira-zip': 'keepUgoiraZip',
    name: 'name',
    'by-tag': 'byTag',
    jobs: 'jobs',
    delay: 'delay',
    retries: 'retries',
    timeout: 'timeout',
    proxy: 'proxy',
    'dry-run': 'dryRun',
    force: 'force',
    'no-resume': 'noResume',
    json: 'json',
    verbose: 'verbose',
  };
  for (const [key, cfgKey] of Object.entries(map)) {
    if (values[key] !== undefined) out[cfgKey] = values[key];
  }
  for (const k of ['minBookmarks', 'maxBookmarks', 'limit', 'maxPages', 'ugoiraWidth', 'jobs', 'delay', 'retries', 'timeout']) {
    if (out[k] !== undefined && out[k] !== null) out[k] = toNum(out[k], k);
  }
  return out;
}

function validateCommon(config) {
  if (!['date', 'popular'].includes(config.sort)) throw new UserError('--sort 只能是 date 或 popular', 2);
  if (!['illust', 'manga', 'all'].includes(config.type)) throw new UserError('--type 只能是 illust/manga/all', 2);
  if (!['exclude', 'include', 'only'].includes(config.r18)) throw new UserError('--r18 只能是 exclude/include/only', 2);
  if (!['exclude', 'include', 'only'].includes(config.ai)) throw new UserError('--ai 只能是 exclude/include/only', 2);
  if (!['gif', 'mp4', 'zip', 'skip'].includes(config.ugoira)) throw new UserError('--ugoira 只能是 gif/mp4/zip/skip', 2);
  if (config.minBookmarks < 0 || (config.maxBookmarks != null && config.maxBookmarks < config.minBookmarks)) {
    throw new UserError('收藏数范围不合法', 2);
  }
  if (config.since && !/^\d{4}-\d{2}-\d{2}$/.test(config.since)) throw new UserError('--since 需要 YYYY-MM-DD', 2);
  if (config.until && !/^\d{4}-\d{2}-\d{2}$/.test(config.until)) throw new UserError('--until 需要 YYYY-MM-DD', 2);
}

function validateDownload(config, tags) {
  if (tags.length === 0) throw new UserError('请至少提供一个标签，例如：ptdl download 初音ミク -m 1000', 2);
  validateCommon(config);
}

function createApi(config, log) {
  return new PixivApi({
    getAuth: () => getAuth(config, log),
    delay: config.delay,
    timeout: config.timeout,
    retries: config.retries,
    log,
  });
}

function applyPremiumSortFallback(config, auth, log) {
  if (config.sort === 'popular' && !auth.user?.is_premium) {
    log.warn('当前账号非 Premium：--sort popular 实测会退化为时间排序，已自动改用 date。');
    config.sort = 'date';
  }
}

/** 清理上次中断留下的 .part 文件与 .pixivdl/tmp 临时目录。 */
function removeLeftovers(outDir) {
  try {
    rmSync(join(outDir, '.pixivdl', 'tmp'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.pixivdl') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.part')) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(outDir);
}

function installSignalHandlers(getState, log) {
  let firing = false;
  const handler = (sig) => {
    if (firing) return;
    firing = true;
    try {
      getState()?.releaseLock();
    } catch {
      /* ignore */
    }
    log?.warn?.(`\n收到 ${sig}：已释放锁并退出（扫描游标逐页保存，可直接重跑续跑）`);
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

function readFailedEntries(outDir) {
  const file = join(outDir, '.pixivdl', 'failed.jsonl');
  const map = new Map();
  if (!existsSync(file)) return { entries: [], file };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const it = JSON.parse(line.replace(/^\uFEFF/, ''));
      if (it?.pid != null) map.set(String(it.pid), { ...map.get(String(it.pid)), ...it });
    } catch {
      /* 跳过损坏行 */
    }
  }
  return { entries: [...map.values()], file };
}

function writeFailedEntries(file, entries) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  renameSync(tmp, file);
}

async function runSubprocess(script, argv) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', script), ...argv], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

async function commandDownload(argv) {
  const { values, positionals } = parseCli(argv);
  if (values.help) {
    console.log(HELP);
    return;
  }
  const { config: fileConfig, configFiles } = loadConfig({ configPath: values.config });
  const config = { ...fileConfig, ...cliToConfig(values) };
  config.out = resolve(config.out);
  config.until = config.until ?? isoDate();
  config.since = config.since ?? null;

  const tags = positionals;
  validateDownload(config, tags);

  const log = createLogger({ quiet: config.json, verbose: config.verbose });
  log.verbose(`配置文件：${configFiles.join(', ') || '(无)'}`);
  log.verbose(`输出目录：${config.out}`);
  log.verbose(`代理：${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '(直连)'}`);

  if (!config.dryRun) mkdirSync(config.out, { recursive: true });
  let state = null;
  if (!config.dryRun) {
    removeLeftovers(config.out);
    state = new State(config.out, { force: config.force, noResume: config.noResume }).load();
    state.acquireLock();
    installSignalHandlers(() => state, log);
  } else {
    state = new State(config.out, { force: config.force, noResume: config.noResume, readonly: true }).load();
  }

  const started = Date.now();
  let downloaded = 0;
  let files = 0;
  let bytes = 0;
  let failed = 0;
  let skipped = 0;
  let candidates = [];
  let scanned = 0;

  try {
    const auth = await getAuth(config, log);
    log(`账号：${auth.user?.name ?? '?'}（${auth.user?.is_premium ? 'Premium' : '非 Premium'}）`);
    applyPremiumSortFallback(config, auth, log);
    const api = createApi(config, log);
    const seen = new Set();
    const searchParams = searchParamsFor(config);
    const scanOpts = { ...config, searchParams };
    const words = config.and ? [tags.join(' ')] : tags;

    outer: for (const word of words) {
      for await (const work of scanTag(api, { word, opts: scanOpts, state, log, seen })) {
        scanned++;
        if (state.isDone(work.id)) {
          skipped++;
          continue;
        }
        if (!passesFilter(work, config)) continue;
        if (work.type === 'ugoira' && config.ugoira === 'skip') {
          skipped++;
          continue;
        }
        candidates.push({ work, tag: word });
        if (config.limit != null && candidates.length >= config.limit) break outer;
      }
    }

    if (config.dryRun) {
      if (config.json) {
        console.log(JSON.stringify({ dryRun: true, tags, scanned, candidates: candidates.map(({ work, tag }) => ({
          id: work.id, bookmarks: work.total_bookmarks, artist: work.user?.name ?? '', type: work.type,
          pages: work.page_count ?? 1, tag,
        })) }, null, 2));
        return;
      }
      for (const { work, tag } of candidates) {
        const name = renderName(config.name, work, {
          page: 0,
          pageCount: work.page_count ?? 1,
          ext: work.type === 'ugoira' ? '' : '.jpg',
        });
        console.log(
          `[dry-run] ${name}  收藏=${work.total_bookmarks}  画师=${work.user?.name ?? '?'}  类型=${work.type}  标签=${tag}`,
        );
      }
      log(`\n[dry-run] 候选 ${candidates.length} 个，扫描 ${scanned} 条；未下载、未写状态。`);
      return;
    }

    if (candidates.length === 0) {
      log('\n没有符合条件的作品。');
      printSummary();
      return;
    }

    log(`\n开始下载 ${candidates.length} 个作品（并发 ${config.jobs}）…`);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= candidates.length) return;
        const { work, tag } = candidates[idx];
        try {
          const r = await downloadWork({ work, outDir: config.out, opts: config, api, state, log, tag });
          downloaded++;
          files += r.files.length;
          bytes += r.bytes;
          log(`✓ ${work.id} ${work.user?.name ?? '?'} 收藏=${work.total_bookmarks} → ${r.files.map((f) => f.slice(config.out.length + 1)).join(', ')}`);
        } catch (e) {
          failed++;
          state.addFailed({
            pid: work.id,
            tag,
            artist: work.user?.name ?? '',
            bookmarks: work.total_bookmarks ?? 0,
            type: work.type ?? '',
            stage: 'download',
            error: e.message,
          });
          log.warn(`✗ ${work.id}（${work.user?.name ?? '?'}）：${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.jobs) }, worker));
  } finally {
    if (!config.dryRun) state.releaseLock();
  }

  function printSummary() {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (config.json) {
      console.log(
        JSON.stringify(
          {
            ok: failed === 0,
            tags,
            scanned,
            candidates: candidates.length,
            downloaded,
            skipped,
            failed,
            files,
            bytes,
            seconds: Number(seconds),
            out: config.out,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log('\n== 完成 ==');
    console.log(`标签: ${tags.join(', ')}`);
    console.log(`扫描: ${scanned} 条 | 候选: ${candidates.length} | 下载: ${downloaded} 个作品 (${files} 文件, ${(bytes / 1024 / 1024).toFixed(1)} MB) | 跳过: ${skipped} | 失败: ${failed}`);
    console.log(`耗时: ${seconds}s | 输出: ${config.out}`);
    if (failed > 0) console.log(`失败详情见 ${join(config.out, '.pixivdl', 'failed.jsonl')}（可运行 ptdl retry 重试）`);
  }

  printSummary();
  if (failed > 0) process.exitCode = 1;
}

async function commandRetry(argv) {
  const { values } = parseCli(argv);
  if (values.help) {
    console.log(HELP);
    return;
  }
  const { config: fileConfig } = loadConfig({ configPath: values.config });
  const config = { ...fileConfig, ...cliToConfig(values) };
  config.out = resolve(config.out);
  validateCommon(config);

  const log = createLogger({ quiet: config.json, verbose: config.verbose });
  const { entries, file } = readFailedEntries(config.out);
  if (entries.length === 0) {
    if (config.json) console.log(JSON.stringify({ ok: true, retried: 0, remaining: 0, note: 'failed.jsonl 为空或不存在' }, null, 2));
    else console.log(`没有失败记录：${file}`);
    return;
  }

  let state = null;
  if (!config.dryRun) {
    mkdirSync(config.out, { recursive: true });
    removeLeftovers(config.out);
    state = new State(config.out, { force: config.force, noResume: config.noResume }).load();
    state.acquireLock();
    installSignalHandlers(() => state, log);
  } else {
    state = new State(config.out, { force: config.force, noResume: config.noResume, readonly: true }).load();
  }

  const started = Date.now();
  let retried = 0;
  let failed = 0;
  let droppedFilter = 0;
  let unavailable = 0;
  const remaining = [];

  try {
    const auth = await getAuth(config, log);
    log(`账号：${auth.user?.name ?? '?'}（${auth.user?.is_premium ? 'Premium' : '非 Premium'}）`);
    const api = createApi(config, log);

    const queue = entries.filter((e) => {
      if (state.isDone(e.pid)) return false; // 已下载：直接移除
      return true;
    });

    if (config.dryRun) {
      for (const e of queue) console.log(`[dry-run] retry ${e.pid} tag=${e.tag ?? '?'} 收藏=${e.bookmarks ?? '?'} ${e.artist ?? ''}`);
      log(`\n[dry-run] 待重试 ${queue.length} 条（共 ${entries.length} 条失败记录）。`);
      return;
    }

    log(`\n开始重试 ${queue.length} 个失败项（并发 ${config.jobs}）…`);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const entry = queue[idx];
        let work;
        try {
          work = await api.illustDetail(entry.pid);
        } catch (e) {
          unavailable++;
          log.warn(`✗ ${entry.pid} 无法获取详情（可能已删除/私有）：${e.message}`);
          remaining.push({ ...entry, stage: 'detail', error: e.message });
          continue;
        }
        if (!passesFilter(work, config)) {
          droppedFilter++;
          log.warn(`- ${entry.pid} 已不满足当前过滤条件（当前收藏=${work.total_bookmarks}），不再重试`);
          continue;
        }
        if (work.type === 'ugoira' && config.ugoira === 'skip') {
          droppedFilter++;
          continue;
        }
        try {
          const r = await downloadWork({ work, outDir: config.out, opts: config, api, state, log, tag: entry.tag ?? '' });
          retried++;
          log(`✓ retry ${work.id} → ${r.files.length} 文件`);
        } catch (e) {
          failed++;
          log.warn(`✗ retry ${work.id}：${e.message}`);
          remaining.push({
            ...entry,
            artist: work.user?.name ?? entry.artist ?? '',
            bookmarks: work.total_bookmarks ?? entry.bookmarks ?? 0,
            stage: 'download',
            error: e.message,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.jobs) }, worker));

    writeFailedEntries(file, remaining);
  } finally {
    if (!config.dryRun) state.releaseLock();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (config.json) {
    console.log(JSON.stringify({ ok: failed === 0 && remaining.length === 0, retried, failed, droppedFilter, unavailable, remaining: remaining.length, seconds: Number(seconds), out: config.out }, null, 2));
  } else {
    console.log('\n== retry 完成 ==');
    console.log(`重试成功: ${retried} | 仍失败: ${failed} | 过滤跳过: ${droppedFilter} | 不可用: ${unavailable} | 剩余失败记录: ${remaining.length} | 耗时: ${seconds}s`);
  }
  if (remaining.length > 0) process.exitCode = 1;
}

export async function main(argv) {
  const first = argv[0];
  try {
    if (!first || first === '--help' || first === '-h') {
      console.log(HELP);
      return;
    }
    if (first === '--version' || first === '-V') {
      console.log(`ptdl ${readVersion()}`);
      return;
    }
    if (first === 'login') return await runSubprocess('login.mjs', argv.slice(1));
    if (first === 'doctor') return await runSubprocess('probe.mjs', argv.slice(1));
    if (first === 'download') return await commandDownload(argv.slice(1));
    if (first === 'retry') return await commandRetry(argv.slice(1));
    if (first.startsWith('-')) return await commandDownload(argv); // 兼容省略 download
    throw new UserError(`未知命令：${first}\n\n${HELP}`, 2);
  } catch (e) {
    if (e instanceof UserError) {
      console.error(`错误：${e.message}`);
      process.exitCode = e.exitCode;
    } else {
      console.error(`错误：${e.message}`);
      if (process.env.PTDL_DEBUG) console.error(e.stack);
      process.exitCode = 1;
    }
  }
}
