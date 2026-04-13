/**
 * ETag 条件付きキャッシュ検証 (両 worker 共通)
 *
 * Phase 8 で導入。imagy / imagy-text 両 worker から import される。
 *
 * 仕組み:
 * 1. edgeCache (caches.default) から URL ベースで cached を探す
 * 2. cached があれば ETag → `If-None-Match`、
 *    ETag が無ければ Last-Modified → `If-Modified-Since` を付ける
 * 3. origin が 304 を返したら → `kind: 'cached'` で cached を返す
 *    (decode/encode/minify は不要、worker CPU を節約)
 * 4. origin が 200 (or 4xx/5xx) を返したら → `kind: 'fresh'` で
 *    upstream を返す。呼び出し側で通常の処理を続ける
 *
 * これにより origin が更新された場合、最大 TTL ぶん待たず次のリクエストで
 * 反映される (round-trip 1 回ぶんのコストで反映)。
 */

/**
 * @typedef {Object} ValidationParams
 * @property {Request} request - cache key 用の元 Request
 * @property {string} originUrl - 実 origin URL
 * @property {Record<string,string>} fetchHeaders - 既定の fetch headers
 * @property {AbortSignal} signal - AbortSignal
 * @property {Cache | null | undefined} edgeCache - caches.default or null
 */

/**
 * @typedef {Object} ValidationResult
 * @property {'cached' | 'fresh'} kind
 * @property {Response} [cached] - kind === 'cached' のとき
 * @property {Response} [upstream] - kind === 'fresh' のとき
 * @property {string} historyTag - process_history に追記する短いタグ
 */

/**
 * @param {ValidationParams} params
 * @returns {Promise<ValidationResult>}
 */
export async function fetchUpstreamWithCacheValidation({
  request,
  originUrl,
  fetchHeaders,
  signal,
  edgeCache,
}) {
  // edgeCache が無い (workers.dev でテスト中、もしくは caches アクセス不可) → 普通に fetch
  let cached = null;
  if (edgeCache) {
    try {
      cached = await edgeCache.match(request);
    } catch {
      cached = null;
    }
  }

  const cachedEtag = cached?.headers.get('etag');
  const cachedLastModified = cached?.headers.get('last-modified');

  // ETag or Last-Modified で条件付きリクエストを構成
  const headers = { ...fetchHeaders };
  if (cachedEtag) {
    headers['If-None-Match'] = cachedEtag;
  } else if (cachedLastModified) {
    headers['If-Modified-Since'] = cachedLastModified;
  }

  const upstream = await fetch(originUrl, {
    method: 'GET',
    headers,
    signal,
  });

  // origin が 304 を返した → cached をそのまま使う
  if (upstream.status === 304 && cached) {
    return {
      kind: 'cached',
      cached,
      historyTag: cachedEtag ? '[hit-validated]' : '[hit-lm]',
    };
  }

  // それ以外 (200/4xx/5xx) → upstream を呼び出し側で処理
  return {
    kind: 'fresh',
    upstream,
    historyTag: cached ? '[cache-stale]' : '',
  };
}
