/**
 * レスポンスヘッダー組み立て (Cloudflare Worker 用)
 *
 * httpdocs/shared/headers.js (AWS 版) の buildCacheControl と仕様を揃える:
 * - _nc あり        → no-store, history "[nc]"
 * - _cc=N あり      → public, max-age=N, history "[cc]"
 * - 何もなし        → public, max-age=DEFAULT_CACHE_TTL
 */

import { DEFAULT_CACHE_TTL } from './constants.js';

/**
 * @param {{_nc?: boolean, _cc?: string|undefined}} params - parseImagyParams の戻り値
 * @returns {{ value: string, historyAppend: string }}
 */
export function buildCacheControl(params) {
  if (params._nc) {
    return { value: 'no-store', historyAppend: '[nc]' };
  }

  if (params._cc !== undefined) {
    const seconds = parseInt(params._cc, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { value: `public, max-age=${seconds}`, historyAppend: '[cc]' };
    }
  }

  return { value: `public, max-age=${DEFAULT_CACHE_TTL}`, historyAppend: '' };
}

/**
 * リジェクション redirect 用の Location URL を生成。
 * AWS 版と同じく `_r=<timestamp>` を追加し、CDN 側でリダイレクトが
 * 同じキーでキャッシュされ続けないようにする。
 */
export function buildRejectionLocation(originUrl) {
  const url = new URL(originUrl);
  url.searchParams.set('_r', String(Date.now()));
  return url.href;
}
