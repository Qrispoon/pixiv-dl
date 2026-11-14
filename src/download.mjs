/**
 * 下载器：原图多页 + ugoira（zip / gif / mp4）。
 */

import { mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_UA } from './common.mjs';
import { downloadToFile, extFromUrl } from './http.mjs';
import { renderName, sanitizeName } from './naming.mjs';
import { cleanupDir, convertUgoira, ugoiraZipUrl } from './ugoira.mjs';

const IMAGE_HEADERS = {
  'User-Agent': WEB_UA,
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  Referer: 'https://www.pixiv.net/',
};

function imageUrls(work) {
  const single = work.meta_single_page?.original_image_url;
  if (single) return [single];
  if (Array.isArray(work.meta_pages) && work.meta_pages.length) {
    return work.meta_pages.map((p) => p.image_urls?.original).filter(Boolean);
  }
  return null;
}

async function resolveImageUrls(api, work) {
  let urls = imageUrls(work);
  if (urls && urls.length) return urls;
  const detail = await api.illustDetail(work.id);
  urls = imageUrls(detail);
  if (!urls || urls.length === 0) throw new Error('作品没有可用的原图 URL');
  return urls;
}

export function targetDir(outDir, opts, tag) {
  return opts.byTag ? join(outDir, sanitizeName(tag, 80) || 'tag') : outDir;
}

export async function downloadWork({ work, outDir, opts, api, state, log, tag }) {
  const dir = targetDir(outDir, opts, tag);
  mkdirSync(dir, { recursive: true });
  const files = [];
  let bytes = 0;

  if (work.type === 'ugoira') {
    const meta = await api.ugoiraMetadata(work.id);
    const frames = meta.frames ?? [];
    const zipUrl = ugoiraZipUrl(meta);
    if (!zipUrl || frames.length === 0) throw new Error('ugoira 元数据缺失 frames/zip_urls');
    const base = renderName(opts.name, work, { ugoira: true });
    const zipFinal = join(dir, `${base}.zip`);
    const tmpDir = join(outDir, '.pixivdl', 'tmp', String(work.id));
    mkdirSync(tmpDir, { recursive: true });
    const zipTmp = join(tmpDir, 'src.zip');
    try {
      const z = await downloadToFile(zipUrl, zipTmp, {
        headers: IMAGE_HEADERS,
        timeout: opts.timeout * 1000,
        retries: opts.retries,
        log,
      });
      bytes += z.bytes;
      if (opts.ugoira === 'zip') {
        renameSync(zipTmp, zipFinal);
        files.push(zipFinal);
      } else {
        if (!opts.keepUgoiraZip) {
          // 转码成功后默认不保留 zip
        }
        const out = await convertUgoira({
          zipPath: zipTmp,
          frames,
          outBase: join(dir, base),
          kind: opts.ugoira,
          width: opts.ugoiraWidth,
          workDir: tmpDir,
          log,
        });
        files.push(out.file);
        bytes += out.bytes;
        if (opts.keepUgoiraZip) {
          renameSync(zipTmp, zipFinal);
          files.push(zipFinal);
        }
      }
    } catch (e) {
      // 转码失败：降级保留 zip
      if (opts.ugoira !== 'zip' && !files.length) {
        try {
          renameSync(zipTmp, zipFinal);
          files.push(zipFinal);
          log?.warn?.(`ugoira 转码失败，已保留 zip：${zipFinal}\n  ${e.message}`);
        } catch {
          throw e;
        }
      } else {
        throw e;
      }
    } finally {
      try {
        unlinkSync(zipTmp);
      } catch {
        /* ignore */
      }
      cleanupDir(tmpDir);
    }
    state.markDone(work, files);
    return { files, bytes };
  }

  const urls = await resolveImageUrls(api, work);
  const pageCount = urls.length;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ext = extFromUrl(url);
    const name = renderName(opts.name, work, { page: i, pageCount, ext });
    const path = join(dir, name);
    const r = await downloadToFile(url, path, {
      headers: IMAGE_HEADERS,
      timeout: opts.timeout * 1000,
      retries: opts.retries,
      log,
    });
    files.push(path);
    bytes += r.bytes;
  }
  state.markDone(work, files);
  return { files, bytes };
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
