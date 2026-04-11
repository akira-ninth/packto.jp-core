/**
 * CSS minifier (csso ラッパ)
 *
 * csso は pure JS の CSS minifier。AST ベースで構造的最適化を行う。
 * Workers (workerd) 上でも動作する。
 */

import { minify } from 'csso';

/**
 * @param {string} text
 * @returns {string} minified CSS
 * @throws csso が壊れた CSS で例外を投げることがある
 */
export function minifyCss(text) {
  const result = minify(text, {
    sourceMap: false,
    restructure: true,
    comments: 'exclamation', // !important コメントは保持、それ以外は削除
  });
  return result.css;
}
