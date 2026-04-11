/**
 * minifier dispatch
 *
 * detectTextFormat の結果 ('js'|'css'|'svg'|'json') を受け取り、
 * 対応する minifier を呼ぶ。失敗時は呼び出し側 (convertText) で
 * try/catch して 100% フォールバックに倒す。
 */

import { minifyJs } from './js.js';
import { minifyCss } from './css.js';
import { minifySvg } from './svg.js';
import { minifyJson } from './json.js';

/**
 * @param {'js'|'css'|'svg'|'json'} format
 * @param {string} text
 * @param {object} options
 * @param {boolean} [options.module] - .mjs ES module フラグ (js のみ使用)
 * @returns {Promise<string>} minified text
 */
export async function minifyByFormat(format, text, options = {}) {
  switch (format) {
    case 'js':   return minifyJs(text, options);
    case 'css':  return minifyCss(text);
    case 'svg':  return minifySvg(text);
    case 'json': return minifyJson(text);
    default:
      throw new Error(`unsupported text format: ${format}`);
  }
}

/**
 * 単純な存在チェック (テスト用)
 */
export function selectMinifier(format) {
  switch (format) {
    case 'js':   return minifyJs;
    case 'css':  return minifyCss;
    case 'svg':  return minifySvg;
    case 'json': return minifyJson;
    default:     return null;
  }
}
