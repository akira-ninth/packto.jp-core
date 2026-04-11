/**
 * Phase 8: cloudflare/src/shared/cache-validation.js のユニットテスト
 *
 * fetchUpstreamWithCacheValidation の各分岐をカバー:
 * - cache miss → fresh fetch (If-None-Match なし)
 * - cache hit + ETag あり + origin 304 → cached を返す
 * - cache hit + ETag あり + origin 200 → fresh upstream を返す
 * - cache hit + ETag なし → fresh fetch (検証スキップ)
 * - edgeCache が null/undefined → fresh fetch
 *
 * global fetch を mock し、edgeCache を Map ベースの fake で代替する。
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { fetchUpstreamWithCacheValidation } from '../../src/shared/cache-validation.js';

/**
 * Cloudflare Cache API を最小限模倣する fake。
 * Request URL を文字列キーにして Response を保持する。
 */
function makeFakeCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      return store.get(key) ?? null;
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      store.set(key, response);
    },
  };
}

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchUpstreamWithCacheValidation', () => {
  it('cache miss → fresh fetch (If-None-Match なし)', async () => {
    const fetchMock = mock.fn(async () => new Response('body', { status: 200 }));
    globalThis.fetch = fetchMock;

    const cache = makeFakeCache();
    const request = new Request('https://example.test/foo.jpg');

    const result = await fetchUpstreamWithCacheValidation({
      request,
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: { 'User-Agent': 'test' },
      signal: undefined,
      edgeCache: cache,
    });

    assert.equal(result.kind, 'fresh');
    assert.equal(result.historyTag, '');
    assert.equal(fetchMock.mock.callCount(), 1);

    const callHeaders = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(callHeaders['If-None-Match'], undefined);
    assert.equal(callHeaders['User-Agent'], 'test');
  });

  it('cache hit + ETag あり + origin 304 → cached を返す', async () => {
    const cache = makeFakeCache();
    const request = new Request('https://example.test/foo.jpg');
    const cachedResponse = new Response('cached-body', {
      status: 200,
      headers: { etag: '"abc123"', 'content-type': 'image/avif' },
    });
    await cache.put(request, cachedResponse);

    const fetchMock = mock.fn(async () => new Response(null, { status: 304 }));
    globalThis.fetch = fetchMock;

    const result = await fetchUpstreamWithCacheValidation({
      request,
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: cache,
    });

    assert.equal(result.kind, 'cached');
    assert.equal(result.historyTag, '[hit-validated]');
    assert.ok(result.cached);
    assert.equal(result.cached.headers.get('etag'), '"abc123"');

    const callHeaders = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(callHeaders['If-None-Match'], '"abc123"');
  });

  it('cache hit + ETag あり + origin 200 → fresh upstream を返す', async () => {
    const cache = makeFakeCache();
    const request = new Request('https://example.test/foo.jpg');
    const cachedResponse = new Response('old-body', {
      status: 200,
      headers: { etag: '"old"' },
    });
    await cache.put(request, cachedResponse);

    const fetchMock = mock.fn(async () => new Response('new-body', {
      status: 200,
      headers: { etag: '"new"' },
    }));
    globalThis.fetch = fetchMock;

    const result = await fetchUpstreamWithCacheValidation({
      request,
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: cache,
    });

    assert.equal(result.kind, 'fresh');
    assert.equal(result.historyTag, '[cache-stale]');
    assert.ok(result.upstream);
    assert.equal(result.upstream.status, 200);
    assert.equal(result.upstream.headers.get('etag'), '"new"');
  });

  it('cache hit + ETag なし → 検証スキップして fresh fetch', async () => {
    const cache = makeFakeCache();
    const request = new Request('https://example.test/foo.jpg');
    const cachedResponse = new Response('cached', {
      status: 200,
      headers: { 'content-type': 'image/avif' },
    });
    await cache.put(request, cachedResponse);

    const fetchMock = mock.fn(async () => new Response('fresh', { status: 200 }));
    globalThis.fetch = fetchMock;

    const result = await fetchUpstreamWithCacheValidation({
      request,
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: cache,
    });

    assert.equal(result.kind, 'fresh');
    assert.equal(result.historyTag, '[cache-stale]');

    const callHeaders = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(callHeaders['If-None-Match'], undefined);
  });

  it('edgeCache が null → 普通に fetch', async () => {
    const fetchMock = mock.fn(async () => new Response('body', { status: 200 }));
    globalThis.fetch = fetchMock;

    const result = await fetchUpstreamWithCacheValidation({
      request: new Request('https://example.test/foo.jpg'),
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: null,
    });

    assert.equal(result.kind, 'fresh');
    assert.equal(result.historyTag, '');
  });

  it('weak ETag (W/"abc") もそのまま If-None-Match に渡す', async () => {
    const cache = makeFakeCache();
    const request = new Request('https://example.test/foo.jpg');
    await cache.put(
      request,
      new Response('body', { status: 200, headers: { etag: 'W/"weak123"' } })
    );

    const fetchMock = mock.fn(async () => new Response(null, { status: 304 }));
    globalThis.fetch = fetchMock;

    await fetchUpstreamWithCacheValidation({
      request,
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: cache,
    });

    const callHeaders = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(callHeaders['If-None-Match'], 'W/"weak123"');
  });

  it('origin 4xx でも cache miss 扱いで fresh を返す (呼び出し側で reject)', async () => {
    const fetchMock = mock.fn(async () => new Response('not found', { status: 404 }));
    globalThis.fetch = fetchMock;

    const result = await fetchUpstreamWithCacheValidation({
      request: new Request('https://example.test/foo.jpg'),
      originUrl: 'https://origin.test/foo.jpg',
      fetchHeaders: {},
      signal: undefined,
      edgeCache: makeFakeCache(),
    });

    assert.equal(result.kind, 'fresh');
    assert.equal(result.upstream.status, 404);
  });
});
