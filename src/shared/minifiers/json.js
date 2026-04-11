/**
 * JSON minifier
 *
 * `JSON.parse → JSON.stringify` で空白・改行を全て除去する。
 * BOM があれば先に除去する (JSON.parse は BOM を受け付けない)。
 */

const BOM = '\uFEFF';

/**
 * @param {string} text
 * @returns {string} minified JSON
 * @throws {SyntaxError} 不正な JSON の場合
 */
export function minifyJson(text) {
  const stripped = text.startsWith(BOM) ? text.slice(1) : text;
  const parsed = JSON.parse(stripped);
  return JSON.stringify(parsed);
}
