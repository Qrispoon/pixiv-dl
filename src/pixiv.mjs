/**
 * App API 客户端（app-api.pixiv.net）。
 */

import { API_BASE, APP_UA, sleep } from './common.mjs';
import { requestJson } from './http.mjs';

export class PixivApi {
  constructor({ getAuth, delay = 2, timeout = 60, retries = 5, log }) {
    this.getAuth = getAuth;
    this.delay = delay;
    this.timeout = timeout * 1000;
    this.retries = retries;
    this.log = log;
  }

  async #headers() {
    const auth = await this.getAuth();
    return {
      'User-Agent': APP_UA,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      'App-Version': '5.0.234',
      Authorization: `Bearer ${auth.accessToken}`,
      Referer: 'https://app-api.pixiv.net/',
    };
  }

  async get(path, params = {}, { retryAuth = true } = {}) {
    await sleep(this.delay);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      query.set(k, String(v));
    }
    const url = `${API_BASE}${path}${query.toString() ? `?${query}` : ''}`;
    const r = await requestJson(url, {
      headers: await this.#headers(),
      timeout: this.timeout,
      retries: this.retries,
      log: this.log,
    });
    if (r.status === 401 && retryAuth) {
      this.log?.warn?.('access_token 失效，重新刷新后重试');
      const { clearAuthCache } = await import('./auth.mjs');
      clearAuthCache();
      return this.get(path, params, { retryAuth: false });
    }
    if (r.status !== 200) {
      const msg = r.json?.error?.message ?? r.json?.error ?? r.text?.slice(0, 200) ?? '';
      throw new Error(`App API HTTP ${r.status}：${msg}`);
    }
    if (r.json?.error) {
      throw new Error(`App API 错误：${JSON.stringify(r.json.error).slice(0, 300)}`);
    }
    return r.json;
  }

  async search(params) {
    return this.get('/v1/search/illust', params);
  }

  async illustDetail(illustId) {
    const j = await this.get('/v1/illust/detail', { illust_id: illustId });
    return j.illust;
  }

  async ugoiraMetadata(illustId) {
    const j = await this.get('/v1/ugoira/metadata', { illust_id: illustId });
    return j.ugoira_metadata;
  }
}
