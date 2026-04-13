import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import decodePng, { init as initPngDecode } from '@jsquash/png/decode';
import encodePng, { init as initPngEncode } from '@jsquash/png/encode';
import encodeAvif, { init as initAvifEncode } from '@jsquash/avif/encode';
import decodeWebp, { init as initWebpDecode } from '@jsquash/webp/decode';
import encodeWebp, { init as initWebpEncode } from '@jsquash/webp/encode';
import resize, { initResize } from '@jsquash/resize';

// jSquash の package.json は wasm を exports に出していないため、
// node_modules 内の wasm を相対パスで直接参照する。
import JPEG_DEC_WASM from '../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import JPEG_ENC_WASM from '../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import PNG_WASM from '../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import AVIF_ENC_WASM from '../node_modules/@jsquash/avif/codec/enc/avif_enc.wasm';
import WEBP_DEC_WASM from '../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm';
// WebP encoder: Workers は SIMD 対応なので SIMD 版を使う
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import RESIZE_WASM from '../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';

import {
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXEL_COUNT,
  MAX_OUTPUT_PIXEL_COUNT,
  ALLOWED_CONTENT_TYPE_REGEX,
  ALLOWED_IMAGE_PATH_EXTENSION_REGEX,
  ALLOWED_TEXT_PATH_EXTENSION_REGEX,
  ALLOWED_TEXT_CONTENT_TYPE_REGEX,
  WORKER_VERSION,
} from './shared/constants.js';
import {
  AVIF_OPTIONS,
  FETCH_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  JPEG_ENCODE_OPTIONS,
  WEBP_METHOD,
} from './shared/config.js';
import { parseImagyParams, buildOriginUrl } from './shared/querystring.js';
import { buildCacheControl, buildRejectionLocation } from './shared/headers.js';
import { computeTargetSize } from './shared/resize.js';
import {
  detectSourceFormat,
  selectFormat,
  resolveQuality,
  formatContentType,
  detectTextFormat,
} from './shared/format.js';
import { resolveCustomer, extractCustomerSubdomain } from './shared/origin.js';
import { planAllows } from './shared/plans.js';
import { fetchUpstreamWithCacheValidation } from './shared/cache-validation.js';
import { decodeGif } from './shared/gif-decode.js';
import { buildAnimatedWebp } from './shared/webp-mux.js';
import { minifyByFormat } from './shared/minifiers/index.js';

let wasmInitPromise;
function ensureWasm() {
  if (!wasmInitPromise) {
    // PNG は decode/encode が同じ wasm のため初期化は片方だけで OK だが、
    // jSquash の内部キャッシュは別なので両方明示的に呼んでおく。
    wasmInitPromise = Promise.all([
      initJpegDecode(JPEG_DEC_WASM),
      initJpegEncode(JPEG_ENC_WASM),
      initPngDecode(PNG_WASM),
      initPngEncode(PNG_WASM),
      initAvifEncode(AVIF_ENC_WASM),
      initWebpDecode(WEBP_DEC_WASM),
      initWebpEncode(WEBP_ENC_WASM),
      initResize(RESIZE_WASM),
    ]).catch((err) => {
      // init が失敗したら次回呼び出しで再試行できるよう promise をリセット
      // (一時的な network/parse 不具合で isolate 全体が永久に詰まるのを防ぐ)
      wasmInitPromise = undefined;
      throw err;
    });
  }
  return wasmInitPromise;
}

/**
 * Promise.race ベースの全体タイムアウト。指定 ms を超えたら reject する。
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timeout (${ms}ms)`);
    this.name = 'TimeoutError';
    this.label = label;
  }
}

/**
 * AWS 版 buildRejectionResponse 相当。エラー時に origin URL への 301 redirect を返す。
 * 用途: origin の 4xx/5xx, タイムアウト, encode 失敗等で「元画像にフォールバック
 * させたい」ケース。
 */
function buildRejection(originUrl, processHistory) {
  const headers = new Headers({
    'location': buildRejectionLocation(originUrl),
    'referrer-policy': 'no-referrer',
    'cache-control': 'public, max-age=360',
    'x-imagy-version': WORKER_VERSION,
    'x-imagy-process-history': processHistory,
  });
  return new Response(null, { status: 301, headers });
}

/**
 * 完全ブロック用の 404 応答。
 * 用途: 画像でないコンテンツへのアクセスを worker 経由で許さない場合
 * (path 拡張子不一致 / origin が画像以外を返した場合)。
 * buildRejection と違い Location ヘッダを付けないので、ブラウザが追従して
 * origin の HTML を見てしまうことが無い。
 */
function buildForbidden(processHistory) {
  return new Response('Not Found\n', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'x-imagy-version': WORKER_VERSION,
      'x-imagy-process-history': processHistory,
    },
  });
}

/**
 * 成功レスポンス組み立て。
 */
function buildSuccess(body, contentType, originUrl, cache, processHistory, extra = {}) {
  const bodyBytes = body instanceof ArrayBuffer ? body.byteLength : (body?.byteLength ?? 0);
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(bodyBytes),
    'cache-control': cache.value,
    'access-control-allow-origin': '*',
    'link': `<${originUrl}>; rel="canonical"`,
    'vary': 'Accept',
    'x-imagy-version': WORKER_VERSION,
    'x-imagy-process-history': processHistory,
    ...extra,
  });
  return new Response(body, { status: 200, headers });
}

/**
 * フォーマット別エンコード呼び分け
 */
async function encodeImage(imageData, format, params) {
  if (format === 'avif') {
    return encodeAvif(imageData, {
      ...AVIF_OPTIONS,
      quality: resolveQuality(params._q, 'avif'),
    });
  }
  if (format === 'webp') {
    return encodeWebp(imageData, {
      quality: resolveQuality(params._q, 'webp'),
      method: WEBP_METHOD,
    });
  }
  if (format === 'jpeg') {
    return encodeJpeg(imageData, {
      ...JPEG_ENCODE_OPTIONS,
      quality: resolveQuality(params._q, 'jpeg'),
    });
  }
  if (format === 'png') {
    // squoosh_png は quality を受け取らない
    return encodePng(imageData);
  }
  throw new Error(`unsupported encode format: ${format}`);
}

/**
 * Animated GIF を animated WebP に変換する (Phase 9)。
 *
 * 流れ:
 * 1. gifuct-js で GIF をフレーム列に decode (full canvas RGBA、disposal 解決済み)
 * 2. 各フレームを @jsquash/webp で encode (静止画 lossy WebP)
 * 3. 自前 RIFF muxer (buildAnimatedWebp) で ANMF chunk として束ねる
 *
 * 失敗時は呼び出し側 (convertImage) で reject 扱い。
 * AVIF (_avif=1) リクエストも WebP fallback (現状 animated AVIF encoder 無し)。
 *
 * @param {Response} upstream
 * @param {object} params
 * @param {string} startHistory - convertImage で既に積まれた history
 */
async function convertAnimatedGif(upstream, params, startHistory) {
  let history = startHistory;

  const contentLengthHeader = upstream.headers.get('content-length');
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  if (contentLength > MAX_INPUT_BYTES) {
    history += `[lrg:${contentLength}]`;
    return { kind: 'reject', history };
  }

  const inputBuffer = await upstream.arrayBuffer();
  if (inputBuffer.byteLength === 0) {
    history += '[0byte]';
    return { kind: 'reject', history };
  }
  if (inputBuffer.byteLength > MAX_INPUT_BYTES) {
    history += `[lrg:${inputBuffer.byteLength}]`;
    return { kind: 'reject', history };
  }

  let decoded;
  try {
    decoded = decodeGif(inputBuffer);
  } catch {
    // GIF parse 失敗 (壊れた GIF など) → 原本をそのまま返す
    history += '[gif][gif-parse-err]';
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType: 'image/gif',
      history,
    };
  }

  // canvas サイズチェック (memory 安全)
  if (decoded.width * decoded.height > MAX_INPUT_PIXEL_COUNT) {
    history += `[lrg-in:${decoded.width}x${decoded.height}]`;
    return { kind: 'reject', history };
  }
  if (decoded.width * decoded.height > MAX_OUTPUT_PIXEL_COUNT) {
    history += `[lrg-out:${decoded.width}x${decoded.height}]`;
    return { kind: 'reject', history };
  }

  // 静止画 (1 フレームのみ) は通常の WebP encode に倒す
  if (decoded.frames.length === 1) {
    await ensureWasm();
    const single = decoded.frames[0];
    const imageData = {
      data: single.rgba,
      width: decoded.width,
      height: decoded.height,
    };
    const webpBuffer = await encodeWebp(imageData, {
      quality: resolveQuality(params._q, 'webp'),
      method: WEBP_METHOD,
    });
    history += '[gif-static-webp]';
    if (webpBuffer.byteLength >= inputBuffer.byteLength) {
      history += '[100%]';
      return {
        kind: 'origin-buffer',
        buffer: inputBuffer,
        contentType: 'image/gif',
        history,
      };
    }
    const ratio = (webpBuffer.byteLength / inputBuffer.byteLength * 100).toFixed(2);
    history += `[${ratio}%]`;
    return {
      kind: 'encoded',
      buffer: webpBuffer,
      format: 'webp',
      width: decoded.width,
      height: decoded.height,
      history,
    };
  }

  // animated: 各フレームを WebP encode
  await ensureWasm();
  const quality = resolveQuality(params._q, 'webp');
  const webpFrames = [];
  for (const frame of decoded.frames) {
    const imageData = {
      data: frame.rgba,
      width: decoded.width,
      height: decoded.height,
    };
    let frameWebp;
    try {
      frameWebp = await encodeWebp(imageData, { quality, method: WEBP_METHOD });
    } catch {
      // 1 フレームでも encode 失敗したら諦めて原本パススルー
      history += '[gif][gif-frame-err]';
      return {
        kind: 'origin-buffer',
        buffer: inputBuffer,
        contentType: 'image/gif',
        history,
      };
    }
    webpFrames.push({
      webpBytes: new Uint8Array(frameWebp),
      delay: frame.delay,
    });
  }

  // RIFF muxer で animated WebP に組み立て
  let animated;
  try {
    animated = buildAnimatedWebp({
      width: decoded.width,
      height: decoded.height,
      frames: webpFrames,
      loopCount: decoded.loopCount,
    });
  } catch {
    history += '[gif][gif-mux-err]';
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType: 'image/gif',
      history,
    };
  }

  // _avif=1 だったが WebP にフォールバックしたことを history に明記
  if (params._avif === '1') {
    history += '[gif-noavif]';
  }
  history += `[gif-webp:${decoded.frames.length}f]`;

  // 100% フォールバック: animated WebP が GIF より大きかったら原本
  if (animated.byteLength >= inputBuffer.byteLength) {
    history += '[100%]';
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType: 'image/gif',
      history,
    };
  }

  const ratio = (animated.byteLength / inputBuffer.byteLength * 100).toFixed(2);
  history += `[${ratio}%]`;

  return {
    kind: 'encoded',
    buffer: animated.buffer.slice(animated.byteOffset, animated.byteOffset + animated.byteLength),
    format: 'webp',
    width: decoded.width,
    height: decoded.height,
    history,
  };
}

/**
 * テキスト minify メインロジック (Phase 10 で imagy-text を統合)。
 *
 * @param {Response} upstream
 * @param {object} params
 * @param {URL} requestUrl - format フォールバック判定に使う pathname
 */
async function convertText(upstream, params, requestUrl) {
  let history = '';

  // _min=0 → minify 明示スキップ。origin 応答をそのまま返す
  if (params._min === '0') {
    history += '[min-skip]';
    return { kind: 'passthrough', response: upstream, history };
  }

  if (upstream.status >= 400) {
    history += `[sts:${upstream.status}]`;
    return { kind: 'reject', history };
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (contentType && !ALLOWED_TEXT_CONTENT_TYPE_REGEX.test(contentType)) {
    history += `[nic:${contentType}]`;
    return { kind: 'forbidden', history };
  }

  const contentLengthHeader = upstream.headers.get('content-length');
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  if (contentLength > MAX_INPUT_BYTES) {
    history += `[lrg:${contentLength}]`;
    return { kind: 'reject', history };
  }

  const format = detectTextFormat(contentType, requestUrl.pathname);
  if (!format) {
    history += `[nic:${contentType}]`;
    return { kind: 'forbidden', history };
  }

  const inputBuffer = await upstream.arrayBuffer();
  if (inputBuffer.byteLength === 0) {
    history += '[0byte]';
    return { kind: 'reject', history };
  }
  if (inputBuffer.byteLength > MAX_INPUT_BYTES) {
    history += `[lrg:${inputBuffer.byteLength}]`;
    return { kind: 'reject', history };
  }

  const inputText = new TextDecoder('utf-8').decode(inputBuffer);

  // minify 実行 (失敗は origin 原本を 200 で返すフォールバック)
  let minifiedText;
  try {
    minifiedText = await minifyByFormat(format, inputText, {
      module: requestUrl.pathname.toLowerCase().endsWith('.mjs'),
    });
  } catch {
    history += `[min:${format}][min-err]`;
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType: contentType || 'application/octet-stream',
      history,
    };
  }

  history += `[min:${format}]`;

  const minifiedBuffer = new TextEncoder().encode(minifiedText);

  // 100% フォールバック
  if (minifiedBuffer.byteLength >= inputBuffer.byteLength) {
    history += '[100%]';
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType: contentType || 'application/octet-stream',
      history,
    };
  }

  const ratio = (minifiedBuffer.byteLength / inputBuffer.byteLength * 100).toFixed(2);
  history += `[${ratio}%]`;

  return {
    kind: 'encoded-text',
    buffer: minifiedBuffer,
    format,
    contentType: contentType || 'application/octet-stream',
    outputBytes: minifiedBuffer.byteLength,
    history,
  };
}

/**
 * 画像変換のメインロジック。タイムアウトとエラーは呼び出し側で扱う。
 *
 * Phase 8c でリファクタ: upstream Response を引数に受け取る形に変更。
 * 内部 fetch は撤去し、cache 検証 (fetchUpstreamWithCacheValidation) は
 * fetch handler 側で行う。これにより ETag 条件付き検証が両 worker で
 * 共通化される。
 *
 * @param {Response} upstream - origin から取得済みの Response
 * @param {object} params - parseImagyParams の戻り値
 */
async function convertImage(upstream, params, acceptHeader) {
  let history = '';

  if (upstream.status >= 400) {
    history += `[sts:${upstream.status}]`;
    return { kind: 'reject', history };
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (contentType && !ALLOWED_CONTENT_TYPE_REGEX.test(contentType)) {
    // 拡張子は画像なのに origin が HTML 等を返した場合は forbidden で完全ブロック。
    // 301 で origin にリダイレクトしてしまうとブラウザが追従して HTML を見られる。
    history += `[nic:${contentType}]`;
    return { kind: 'forbidden', history };
  }

  const contentLengthHeader = upstream.headers.get('content-length');
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  if (contentLength > MAX_INPUT_BYTES) {
    history += `[lrg:${contentLength}]`;
    return { kind: 'reject', history };
  }

  const sourceFormat = detectSourceFormat(contentType);

  // GIF: Phase 9 で animated WebP 変換に対応
  // - _webp=1 / _avif=1 → animated WebP に変換 (AVIF は未実装で WebP fallback)
  // - その他 → 従来通り passthrough
  if (sourceFormat === 'gif') {
    const wantsAnimatedConvert = params._webp === '1' || params._avif === '1';
    if (!wantsAnimatedConvert) {
      history += '[gif]';
      return { kind: 'passthrough', response: upstream, history };
    }
    return await convertAnimatedGif(upstream, params, history);
  }

  if (sourceFormat !== 'jpeg' && sourceFormat !== 'png' && sourceFormat !== 'webp') {
    // 拡張子チェックは通ったが decode できないフォーマット (例: heif)。
    // worker から HTML 等を返してしまわないよう forbidden 扱い。
    history += `[nic:${contentType}]`;
    return { kind: 'forbidden', history };
  }

  const inputBuffer = await upstream.arrayBuffer();
  if (inputBuffer.byteLength === 0) {
    history += '[0byte]';
    return { kind: 'reject', history };
  }
  if (inputBuffer.byteLength > MAX_INPUT_BYTES) {
    history += `[lrg:${inputBuffer.byteLength}]`;
    return { kind: 'reject', history };
  }

  await ensureWasm();

  let imageData;
  if (sourceFormat === 'png') {
    imageData = await decodePng(inputBuffer);
  } else if (sourceFormat === 'webp') {
    imageData = await decodeWebp(inputBuffer);
  } else {
    imageData = await decodeJpeg(inputBuffer);
  }

  // 入力ピクセル数チェック (Workers 128MB メモリ制約での OOM 予防)
  // imageData は既に decode されているがここで早期 reject することで
  // resize/encode の追加バッファ確保を避ける
  const inputPixelCount = imageData.width * imageData.height;
  if (inputPixelCount > MAX_INPUT_PIXEL_COUNT) {
    history += `[lrg-in:${imageData.width}x${imageData.height}]`;
    return { kind: 'reject', history };
  }

  // リサイズ
  const target = computeTargetSize(imageData.width, imageData.height, params._w, params._h);

  // 出力ピクセル数チェック (encoder の WASM メモリ制約)
  // jSquash AVIF/WebP encoder は ~2M px あたりで失敗するため事前に reject。
  // resize する場合は target、しない場合は source を encoder に渡すので
  // 両方のケースで output の実体ピクセル数をチェックする。
  const outputW = target ? target.width : imageData.width;
  const outputH = target ? target.height : imageData.height;
  if (outputW * outputH > MAX_OUTPUT_PIXEL_COUNT) {
    history += `[lrg-out:${outputW}x${outputH}]`;
    return { kind: 'reject', history };
  }

  if (target && (target.width !== imageData.width || target.height !== imageData.height)) {
    if (params._w && params._h) {
      history += '[wh]';
    } else if (params._w) {
      history += '[w]';
    } else {
      history += '[h]';
    }
    imageData = await resize(imageData, {
      width: target.width,
      height: target.height,
    });
  }

  // 出力フォーマット決定
  const outputFormat = selectFormat(params, sourceFormat, acceptHeader);
  history += `[${outputFormat}]`;

  const encodedBuffer = await encodeImage(imageData, outputFormat, params);

  // 100% フォールバック: リサイズ無し・同フォーマット返却で圧縮率が悪い場合は元画像を返す
  // (AWS 版踏襲。フォーマットを変えた場合 (avif/webp 等) は通用しないので除外)
  const isResized = !!target;
  const sameFormat = outputFormat === sourceFormat;
  if (!isResized && sameFormat && encodedBuffer.byteLength >= inputBuffer.byteLength) {
    history += '[100%]';
    return {
      kind: 'origin-buffer',
      buffer: inputBuffer,
      contentType,
      history,
    };
  }

  const ratio = (encodedBuffer.byteLength / inputBuffer.byteLength * 100).toFixed(2);
  history += `[${ratio}%]`;

  return {
    kind: 'encoded',
    buffer: encodedBuffer,
    format: outputFormat,
    width: imageData.width,
    height: imageData.height,
    _rgbaCopy: imageData.data.slice(),
    history,
  };
}

// 許可する HTTP method。WAF/rate-limit を method ベースで張る運用に備え、
// 想定外の method は早期に弾く。
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

export default {
  async fetch(request, env, ctx) {
    // Phase 12a/12c: Analytics Engine 用の収集オブジェクト。
    // IIFE 内で各分岐がここを mutate し、finally で 1 度だけ writeDataPoint する。
    const analytics = {
      customer: null,    // 顧客サブドメイン (rays-hd 等)、不明なら 'unknown'
      kind: 'unknown',   // 'image' / 'text' / 'unknown'
      format: '',        // 'avif' / 'webp' / 'js' / 'css' / ... (encoded のとき)
      cacheStatus: 'NONE', // 'HIT-VALIDATED' / 'MISS' / 'NONE'
      outputBytes: 0,    // 最終レスポンスのバイト数 (encoded/origin-buffer は確定)
      inputBytes: 0,     // upstream content-length (12c で追加、圧縮率の分母)
      pathname: '',      // request pathname (大きい配信画像の履歴用)
    };

    let response;
    try {
      response = await (async () => {
        // S1: method 制限。POST/PUT/DELETE/OPTIONS/PATCH 等は 405 で reject
        if (!ALLOWED_METHODS.has(request.method)) {
          return new Response(`Method ${request.method} not allowed\n`, {
            status: 405,
            headers: {
              'allow': 'GET, HEAD',
              'content-type': 'text/plain; charset=utf-8',
              'x-imagy-version': WORKER_VERSION,
              'x-imagy-process-history': `[method:${request.method}]`,
            },
          });
        }

        const requestUrl = new URL(request.url);

        // Phase 10: 拡張子で image / text / 不正 を判別
        const isImagePath = ALLOWED_IMAGE_PATH_EXTENSION_REGEX.test(requestUrl.pathname);
        const isTextPath  = ALLOWED_TEXT_PATH_EXTENSION_REGEX.test(requestUrl.pathname);
        if (!isImagePath && !isTextPath) {
          return buildForbidden('[ext:none]');
        }
        const requestKind = isImagePath ? 'image' : 'text';
        analytics.kind = requestKind;
        analytics.customer = extractCustomerSubdomain(requestUrl.hostname) || 'unknown';
        analytics.pathname = requestUrl.pathname.slice(0, 200); // AE blob は文字数制限があるので 200 文字まで

    const params = parseImagyParams(requestUrl.searchParams);
    const cache = buildCacheControl(params);

    let history = '';
    if (cache.historyAppend) history += cache.historyAppend;

    // Phase 6/10/11: 顧客解決 (origin + plan)
    // Phase 11 で KV (env.CUSTOMERS) → hardcode フォールバックの非同期解決に変更
    const customer = await resolveCustomer(requestUrl, env);
    if (customer === null) {
      history += `[unknown-customer:${requestUrl.hostname}]`;
      return new Response(`Unknown customer: ${requestUrl.hostname}\n`, {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-imagy-version': WORKER_VERSION,
          'x-imagy-process-history': history,
        },
      });
    }
    const originUrl = buildOriginUrl(requestUrl, customer.origin);

    // Phase 10: プラン制御 — text 機能が無いプランは silent passthrough
    // (画像は全プラン許可されている前提で plan check はしない)
    const planTextDisabled = requestKind === 'text' && !planAllows(customer.plan, 'text');

    // Cache API: workers.dev では実質 no-op だが、Phase 6 のカスタムドメインで有効化される。
    const cacheable = !params._nc && !params._t;
    let edgeCache;
    try {
      edgeCache = caches.default;
    } catch {
      edgeCache = null;
    }

    const fetchController = new AbortController();
    const fetchTimer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);

    try {
      // _t passthrough or プラン無効: cache 検証も処理もせず origin 応答そのまま
      if (params._t || planTextDisabled) {
        history += params._t ? '[t]' : '[plan:no-text]';
        const upstream = await fetch(originUrl, {
          signal: fetchController.signal,
          headers: {
            'Accept-Encoding': 'gzip,deflate,br',
            'Accept': requestKind === 'image'
              ? 'image/jpeg,image/png,image/gif,image/webp'
              : 'application/javascript,text/javascript,text/css,application/json,image/svg+xml',
            'User-Agent': 'packto.jp (cf)',
          },
        });
        clearTimeout(fetchTimer);
        const headers = new Headers(upstream.headers);
        headers.set('x-imagy-version', WORKER_VERSION);
        headers.set('x-imagy-process-history', history);
        // _t/plan passthrough は input ≒ output
        const ptLen = parseInt(headers.get('content-length') || '0', 10);
        if (ptLen) {
          analytics.inputBytes = ptLen;
          analytics.outputBytes = ptLen;
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers,
        });
      }

      // ETag 条件付き検証: cache hit のときは origin に If-None-Match で問い合わせ。
      // requestKind に応じて Accept ヘッダを切り替える。
      const validated = await fetchUpstreamWithCacheValidation({
        request,
        originUrl,
        fetchHeaders: {
          'Accept-Encoding': 'gzip,deflate,br',
          'Accept': requestKind === 'image'
            ? 'image/jpeg,image/png,image/gif,image/webp'
            : 'application/javascript,text/javascript,text/css,application/json,image/svg+xml',
          'User-Agent': 'packto.jp (cf)',
        },
        signal: fetchController.signal,
        edgeCache: cacheable ? edgeCache : null,
      });
      history += validated.historyTag;

      // origin が 304 → cached をそのまま返却 (worker CPU/memory 節約)
      if (validated.kind === 'cached') {
        clearTimeout(fetchTimer);
        analytics.cacheStatus = 'HIT-VALIDATED';
        const cachedLen = parseInt(validated.cached.headers.get('content-length') || '0', 10);
        if (cachedLen) analytics.outputBytes = cachedLen;
        const cachedHeaders = new Headers(validated.cached.headers);
        cachedHeaders.set('x-imagy-cache', 'HIT-VALIDATED');
        return new Response(validated.cached.body, {
          status: validated.cached.status,
          headers: cachedHeaders,
        });
      }
      analytics.cacheStatus = validated.historyTag.includes('cache-stale') ? 'CACHE-STALE' : 'MISS';

      // fresh upstream を kind 別で処理
      const upstream = validated.upstream;
      // Phase 12c: 圧縮率計算の分母として upstream content-length を記録 (origin が
      // 必ず content-length を返す前提。無いときは 0 のまま)
      const upstreamLen = parseInt(upstream.headers.get('content-length') || '0', 10);
      if (upstreamLen) analytics.inputBytes = upstreamLen;
      // キャッシュミス時は AVIF より高速な WebP を優先返却し、
      // バックグラウンドで AVIF をエンコードしてキャッシュに格納する
      const isCacheMiss = !validated.historyTag.includes('cache-stale');
      const clientAccept = request.headers.get('Accept') || '';
      const wantsAvif = requestKind === 'image' && isCacheMiss
        && clientAccept.includes('image/avif') && clientAccept.includes('image/webp');
      const effectiveAccept = wantsAvif
        ? clientAccept.replace('image/avif', '')
        : clientAccept;

      const result = await withTimeout(
        requestKind === 'image'
          ? convertImage(upstream, params, effectiveAccept)
          : convertText(upstream, params, requestUrl),
        TOTAL_TIMEOUT_MS,
        'total',
      );
      if (wantsAvif) result.history += '[avif-deferred]';
      clearTimeout(fetchTimer);

      history += result.history;

      // 200 応答に保存する origin の検証用ヘッダ (cache.put 時に保持)
      const upstreamEtag = upstream.headers.get('etag');
      const upstreamLastModified = upstream.headers.get('last-modified');
      const validationHeaders = {};
      if (upstreamEtag) validationHeaders['etag'] = upstreamEtag;
      if (upstreamLastModified) validationHeaders['last-modified'] = upstreamLastModified;

      let resp;
      if (result.kind === 'encoded') {
        // 画像 encoded
        analytics.format = result.format;
        analytics.outputBytes = result.buffer.byteLength;
        resp = buildSuccess(
          result.buffer,
          formatContentType(result.format),
          originUrl,
          cache,
          history,
          {
            'x-imagy-converted': result.format,
            'x-imagy-output-size': `${result.width}x${result.height}`,
            ...validationHeaders,
          },
        );
      } else if (result.kind === 'encoded-text') {
        // テキスト minified
        analytics.format = result.format;
        analytics.outputBytes = result.outputBytes;
        resp = buildSuccess(
          result.buffer,
          result.contentType,
          originUrl,
          cache,
          history,
          {
            'x-imagy-converted': result.format,
            'x-imagy-output-bytes': String(result.outputBytes),
            ...validationHeaders,
          },
        );
      } else if (result.kind === 'origin-buffer') {
        analytics.outputBytes = result.buffer.byteLength;
        resp = buildSuccess(
          result.buffer,
          result.contentType,
          originUrl,
          cache,
          history,
          validationHeaders,
        );
      } else if (result.kind === 'passthrough') {
        // GIF 等の処理せずそのまま返すケース。upstream のヘッダを尊重しつつ
        // imagy 系ヘッダだけ付与する。ETag も自然に保持される。
        const headers = new Headers(result.response.headers);
        headers.set('x-imagy-version', WORKER_VERSION);
        headers.set('x-imagy-process-history', history);
        const cl = parseInt(headers.get('content-length') || '0', 10);
        if (cl) analytics.outputBytes = cl;
        resp = new Response(result.response.body, {
          status: result.response.status,
          headers,
        });
      } else if (result.kind === 'forbidden') {
        resp = buildForbidden(history);
      } else if (result.kind === 'reject') {
        resp = buildRejection(originUrl, history);
      } else {
        resp = buildRejection(originUrl, history + '[unknown]');
      }

      // ctx.waitUntil で延命しないと isolate がアイドルになった瞬間に
      // cache.put が cancel されうる (Cloudflare 公式推奨パターン)
      // Cache API は GET 応答のみ保存できるので、HEAD のときは put しない
      // (HEAD 応答を put しようとすると "Cannot cache response to non-GET request" エラー)
      if (cacheable && edgeCache && resp.status === 200 && request.method === 'GET') {
        const putPromise = edgeCache.put(request, resp.clone()).catch(() => { /* swallow */ });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(putPromise);

          if (wantsAvif && result.kind === 'encoded' && result.format === 'webp' && result._rgbaCopy) {
            const avifTask = (async () => {
              await ensureWasm();
              const avifBuf = await encodeImage(
                { data: result._rgbaCopy, width: result.width, height: result.height },
                'avif', params,
              );
              const avifResp = buildSuccess(
                avifBuf, 'image/avif', originUrl, cache,
                history.replace('[webp]', '[avif]').replace('[avif-deferred]', '[avif-bg]'),
                { 'x-imagy-converted': 'avif', 'x-imagy-output-size': `${result.width}x${result.height}`, ...validationHeaders },
              );
              await edgeCache.put(request, avifResp);
            })().catch(() => { /* AVIF は best-effort */ });
            ctx.waitUntil(avifTask);
          }
        }
      }
      return resp;
    } catch (error) {
      clearTimeout(fetchTimer);

      if (error?.name === 'TimeoutError') {
        history += `[${error.label}-timeout]`;
      } else if (error?.name === 'AbortError') {
        history += '[abort]';
      } else {
        history += '[err]';
      }

      return buildRejection(originUrl, history);
    }
      })();
    } finally {
      // Phase 12a/12c: Analytics Engine に 1 リクエスト 1 データポイントを送る (fire & forget)
      // 失敗してもリクエストパスは絶対に止めない
      if (env?.ANALYTICS && response) {
        try {
          env.ANALYTICS.writeDataPoint({
            indexes: [analytics.customer || 'unknown'],
            blobs: [
              analytics.kind,
              analytics.format,
              String(response.status),
              analytics.cacheStatus,
              analytics.pathname,     // blob5: request pathname (大きい配信画像の履歴用)
            ],
            doubles: [
              analytics.outputBytes,  // double1
              analytics.inputBytes,   // double2
            ],
          });
        } catch {
          // analytics は壊れても無視
        }
      }
    }
    return response;
  },
};
