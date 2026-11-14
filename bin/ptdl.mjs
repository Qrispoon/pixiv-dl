#!/usr/bin/env node
/**
 * ptdl —— Pixiv 标签下载器入口
 *
 * 职责：
 *   1. 代理重入：Node 内置 fetch 只在进程启动时读取 proxy 环境变量，
 *      所以 `--proxy` / 仅设置了 HTTP(S)_PROXY 但没有 NODE_USE_ENV_PROXY 时，
 *      重新 spawn 自己并注入环境变量（纯 Node 实现，无第三方依赖）。
 *   2. 子命令分发：download（主命令）/ login / doctor。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

const proxyFlagIdx = argv.indexOf('--proxy');
const proxyFromFlag = proxyFlagIdx >= 0 ? argv[proxyFlagIdx + 1] : null;
const proxyFromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const envProxyEnabled = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');

function respawn(envPatch) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...argv], {
      env: { ...process.env, ...envPatch, PTDL_RESPAWNED: '1' },
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      resolve(code ?? 1);
    });
  });
}

async function run() {
  const alreadyRespawned = process.env.PTDL_RESPAWNED === '1';
  if (!alreadyRespawned) {
    if (proxyFromFlag) {
      process.exitCode = await respawn({
        HTTPS_PROXY: proxyFromFlag,
        HTTP_PROXY: proxyFromFlag,
        NODE_USE_ENV_PROXY: '1',
      });
      return;
    }
    if (proxyFromEnv && !envProxyEnabled) {
      process.exitCode = await respawn({ NODE_USE_ENV_PROXY: '1' });
      return;
    }
    // 配置文件里写死的 proxy 也要生效（CLI 未传 --proxy 时）
    try {
      const { loadConfig } = await import('../src/config.mjs');
      const cfgIdx = argv.indexOf('--config');
      const { config } = loadConfig({ configPath: cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined });
      if (config.proxy && !proxyFromEnv) {
        process.exitCode = await respawn({
          HTTPS_PROXY: config.proxy,
          HTTP_PROXY: config.proxy,
          NODE_USE_ENV_PROXY: '1',
        });
        return;
      }
    } catch {
      /* 配置错误交给 CLI 报 */
    }
  }
  const { main } = await import('../src/cli.mjs');
  await main(argv);
}

await run();
