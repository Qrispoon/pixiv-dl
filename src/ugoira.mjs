/**
 * ugoira → GIF / MP4（外部依赖：ffmpeg；解包用 Windows 自带 bsdtar）。
 *
 * 实测命令模板见 docs/02-项目方案.md §10.4：
 *   tar -xf zip -C tmp
 *   ffmpeg -f concat -safe 0 -i list.txt -vf "...palettegen..." palette.png
 *   ffmpeg -f concat -safe 0 -i list.txt -i palette.png -lavfi "...paletteuse..." out.gif
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { UserError } from './common.mjs';

function run(cmd, args, { cwd, logFile } = {}) {
  return new Promise((resolve, reject) => {
    let logFd = null;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        logFd = openSync(logFile, 'a');
      } catch {
        logFd = null;
      }
    }
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', logFd ?? 'ignore'] });
    } catch (e) {
      if (logFd != null) closeSync(logFd);
      reject(new UserError(`无法执行 ${cmd}：${e.message}`));
      return;
    }
    child.on('error', (e) => {
      if (logFd != null) {
        try { closeSync(logFd); } catch {}
        logFd = null;
      }
      reject(new UserError(`无法执行 ${cmd}：${e.message}`));
    });
    child.on('exit', (code) => {
      if (logFd != null) {
        try { closeSync(logFd); } catch {}
        logFd = null;
      }
      if (code === 0) resolve();
      else {
        let detail = '';
        if (logFile) {
          try {
            detail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-4).join('\n');
          } catch {
            /* ignore */
          }
        }
        reject(new Error(`${basename(cmd)} 退出码 ${code}${detail ? `：\n${detail}` : ''}`));
      }
    });
  });
}

function probeCommand(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export async function hasCommand(cmd) {
  // ffmpeg 用 -version；Windows bsdtar 用 --version
  if (await probeCommand(cmd, ['-version'])) return true;
  if (await probeCommand(cmd, ['--version'])) return true;
  return false;
}

export function buildConcatList(frames, listPath, framesDirName = '') {
  const prefix = framesDirName ? `${framesDirName}/` : '';
  const lines = [];
  for (const f of frames) {
    lines.push(`file '${prefix}${f.file}'`, `duration ${(f.delay / 1000).toFixed(3)}`);
  }
  if (frames.length > 0) lines.push(`file '${prefix}${frames.at(-1).file}'`);
  writeFileSync(listPath, lines.join('\n') + '\n');
}

export function ugoiraZipUrl(meta) {
  const urls = meta?.zip_urls ?? {};
  const base = urls.medium ?? urls.original ?? urls.small ?? '';
  return base ? base.replace('_ugoira600x600', '_ugoira1920x1080') : '';
}

/**
 * @param {object} p
 * @param {string} p.zipPath
 * @param {Array<{file:string,delay:number}>} p.frames
 * @param {string} p.outBase  不含扩展名的目标路径
 * @param {'gif'|'mp4'} p.kind
 * @param {number} p.width
 * @param {string} p.workDir  临时目录（调用方清理）
 * @param {object} p.log
 * @returns {Promise<{file:string,bytes:number}>}
 */
export async function convertUgoira({ zipPath, frames, outBase, kind, width = 540, workDir, log }) {
  if (!existsSync(zipPath)) throw new Error(`ugoira zip 不存在：${zipPath}`);
  const [tarOk, ffmpegOk] = await Promise.all([hasCommand('tar'), hasCommand('ffmpeg')]);
  if (!tarOk) throw new UserError('系统缺少 tar（Windows 10+ 自带 bsdtar），无法解包 ugoira；已保留 zip。');
  if (!ffmpegOk) throw new UserError('未找到 ffmpeg，无法转码；已保留 zip。');

  mkdirSync(workDir, { recursive: true });
  const extractDir = join(workDir, 'frames');
  mkdirSync(extractDir, { recursive: true });
  await run('tar', ['-xf', zipPath, '-C', extractDir], { logFile: join(workDir, 'tar.log') });

  const listPath = join(workDir, 'list.txt');
  buildConcatList(frames, listPath, 'frames');
  const palettePath = join(workDir, 'palette.png');
  const outPath = `${outBase}.${kind}`;
  const ffLog = join(workDir, 'ffmpeg.log');

  const scale = `scale=${width}:-2:flags=lanczos`; // 高度取偶数，libx264/yuv420p 要求
  if (kind === 'gif') {
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', `${scale},palettegen=stats_mode=diff`, '-y', palettePath],
      { logFile: ffLog },
    );
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-i', palettePath,
        '-lavfi', `[0:v]${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
        '-loop', '0', '-y', outPath],
      { logFile: ffLog },
    );
  } else {
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', scale, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
        '-movflags', '+faststart', '-y', outPath],
      { logFile: ffLog },
    );
  }

  const { statSync } = await import('node:fs');
  const bytes = statSync(outPath).size;
  log?.verbose?.(`ugoira 转换完成：${outPath}（${(bytes / 1024 / 1024).toFixed(2)} MB）`);
  return { file: outPath, bytes };
}

export function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
