/**
 * クエリストリング操作の共通関数 (Cloudflare Worker 用)
 *
 * httpdocs/shared/querystring.js (AWS 版) と仕様を揃えること。
 * AWS は CloudFront の request オブジェクト、Cloudflare は Fetch API の URL を入力にする
 * 違いがあるため関数シグネチャは異なるが、imagy パラメータを除外する挙動は同一。
 */

import { IMAGY_PARAM_KEYS } from './constants.js';
import { ORIGIN_HOST } from './config.js';

/**
 * 数値クエリ (_w / _h / _q 等) を整数化する。
 * 0 や負値・NaN は無効として null を返す (AWS 版の `parseInt` は NaN になるが、
 * Workers 側で sharp に渡らない代わりに jSquash の resize に直接渡るので
 * 不正値で WASM をクラッシュさせないようガードする)。
 */
export function parseDimension(value) {
  if (value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * imagy 専用パラメータをまとめて取り出す。
 * 値の有無は AWS 版の `'_x' in querystring` と同じ意味で扱う:
 * - キー無し → undefined
 * - 値あり → 文字列
 */
export function parseImagyParams(searchParams) {
  return {
    _avif:  searchParams.get('_avif')  ?? undefined,
    _webp:  searchParams.get('_webp')  ?? undefined,
    _w:     parseDimension(searchParams.get('_w')),
    _h:     parseDimension(searchParams.get('_h')),
    _q:     searchParams.get('_q')     ?? undefined,
    _min:   searchParams.get('_min')   ?? undefined,
    _t:     searchParams.has('_t'),
    _nc:    searchParams.has('_nc'),
    _cc:    searchParams.get('_cc')    ?? undefined,
    _ck:    searchParams.get('_ck')    ?? undefined,
    _debug: searchParams.has('_debug'),
  };
}

/**
 * オリジンへのフェッチ URL を組み立てる。imagy パラメータは除外する。
 *
 * @param {URL} url - 受信リクエストの URL
 * @param {string} [originHost] - オリジン (デフォルト ORIGIN_HOST)
 * @returns {string}
 */
export function buildOriginUrl(url, originHost = ORIGIN_HOST) {
  const cleanParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (IMAGY_PARAM_KEYS.has(key)) continue;
    cleanParams.append(key, value);
  }
  const qs = cleanParams.toString();
  return `${originHost}${url.pathname}${qs ? '?' + qs : ''}`;
}
