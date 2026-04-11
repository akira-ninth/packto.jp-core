/**
 * JavaScript minifier (terser ラッパ)
 *
 * terser は pure JS の JS minifier。Workers (workerd) 上でも動作する。
 * .mjs (ES module) と .js を切り替えて呼び出す。
 */

import { minify } from 'terser';

/**
 * @param {string} text
 * @param {object} options
 * @param {boolean} [options.module] - ES module として扱うか (.mjs)
 * @returns {Promise<string>} minified JS
 * @throws terser が syntax error 等で例外を投げることがある
 */
export async function minifyJs(text, options = {}) {
  const result = await minify(text, {
    ecma: 2020,
    module: !!options.module,
    compress: {
      // safe な範囲の最適化のみ。eval 除去・unsafe 系は無効
      drop_console: false,
      drop_debugger: false,
      unsafe: false,
    },
    mangle: true,
    format: {
      comments: false, // /*! ... */ 以外のコメントを削除
    },
    sourceMap: false,
  });

  if (result.code === undefined) {
    throw new Error('terser returned undefined code');
  }
  return result.code;
}
