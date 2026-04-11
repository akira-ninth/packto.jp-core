/**
 * フォーマット選択と品質解決 (Cloudflare Worker 用)
 *
 * AWS 版 OriginRequest の format 分岐ロジック (httpdocs/OriginRequest/index.js
 * の format 判定ブロック) を純粋関数として切り出したもの。
 */

import { DEFAULT_QUALITY } from './config.js';

/** 画像 MIME type をフォーマット名に正規化する */
export function detectSourceFormat(contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpeg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return null;
}

/**
 * 出力フォーマットを決定する。
 * 優先順: _avif パラメータ → _webp パラメータ → Accept ヘッダー → 元フォーマット
 *
 * Accept ヘッダーによる自動判別はパラメータ未指定時のみ有効。
 * GIF はアニメーション対応のため Accept ベースの変換対象外とする。
 *
 * @param {{_avif?: string, _webp?: string}} params - parseImagyParams の戻り値
 * @param {'jpeg'|'png'|'gif'|null} sourceFormat
 * @param {string} [acceptHeader] - クライアントの Accept ヘッダー
 * @returns {'avif'|'webp'|'jpeg'|'png'|'gif'|null}
 */
export function selectFormat(params, sourceFormat, acceptHeader) {
  if (params._avif === '1') return 'avif';
  if (params._webp === '1') return 'webp';

  // Accept ヘッダーによる自動判別 (GIF は除外)
  if (acceptHeader && sourceFormat !== 'gif') {
    const accept = acceptHeader.toLowerCase();
    if (accept.includes('image/avif')) return 'avif';
    if (accept.includes('image/webp')) return 'webp';
  }

  return sourceFormat;
}

/**
 * _q クエリから品質値を取り出す。
 * 不正値・未指定はフォーマットのデフォルトを返す。PNG は jSquash 側で
 * quality を受け付けないため呼び出し側で無視すること。
 *
 * @param {string|undefined} qParam - parseImagyParams._q
 * @param {'avif'|'webp'|'jpeg'} format
 */
export function resolveQuality(qParam, format) {
  if (qParam !== undefined) {
    const n = parseInt(qParam, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) {
      return n;
    }
  }
  return DEFAULT_QUALITY[format];
}

/** 出力フォーマットに対応する Content-Type */
export function formatContentType(format) {
  switch (format) {
    case 'avif': return 'image/avif';
    case 'webp': return 'image/webp';
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'gif':  return 'image/gif';
    default: return 'application/octet-stream';
  }
}

// ========================================================================
// テキスト系フォーマット (Phase 10 で imagy worker に統合)
// ========================================================================

/**
 * Content-Type と pathname からテキストフォーマット名を返す。
 * Content-Type を優先し、空/不明なら pathname から推定。
 *
 * @param {string|null} contentType
 * @param {string} pathname
 * @returns {'js'|'css'|'svg'|'json'|null}
 */
export function detectTextFormat(contentType, pathname) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('text/css') || ct.includes('application/css')) return 'css';
  if (ct.includes('svg+xml')) return 'svg';
  if (ct.includes('application/json')) return 'json';

  // フォールバック: pathname の拡張子から判定
  const lower = (pathname || '').toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'js';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.json')) return 'json';

  return null;
}

/**
 * テキストフォーマット名から「encoded 応答に付ける Content-Type」を返す。
 * 通常は origin の Content-Type をそのまま使う運用だが、不明確な場合のフォールバック。
 */
export function textFormatContentType(format) {
  switch (format) {
    case 'js':   return 'text/javascript; charset=utf-8';
    case 'css':  return 'text/css; charset=utf-8';
    case 'svg':  return 'image/svg+xml; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    default:     return 'application/octet-stream';
  }
}
