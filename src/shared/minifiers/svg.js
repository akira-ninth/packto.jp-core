/**
 * SVG minifier (lightweight regex 実装)
 *
 * svgo は Node fs 依存で workerd 互換性に難があるため自前実装。
 * path 最適化のような高度な最適化は行わず、空白・コメント除去のみ。
 *
 * 適用する変換 (順序重要):
 * 1. XML 宣言・コメント (`<?...?>` / `<!--...-->`) を削除
 * 2. CDATA 内・属性値内には触らない (リスク最小化のため属性値判定はしない)
 *    → 結果的に属性値内の連続空白が圧縮されるが、SVG では問題にならない範囲
 * 3. タグ間の空白 (`>\s+<`) を削除 (`><`)
 * 4. 連続空白を 1 つに
 * 5. 行頭末空白を除去
 *
 * 注意: 完全な XML パーサではないため、極端な edge case (CDATA に SVG を埋める等)
 *       では安全側に倒すため呼び出し側で 100% フォールバックさせる前提。
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function minifySvg(text) {
  let s = text;

  // 1. XML 宣言を削除 (<?xml ... ?>)
  s = s.replace(/<\?xml[\s\S]*?\?>/g, '');

  // 2. XML/HTML コメントを削除 (<!--...-->)
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 3. DOCTYPE 宣言を削除 (<!DOCTYPE ... >)
  s = s.replace(/<!DOCTYPE[\s\S]*?>/g, '');

  // 4. タグ間の空白を削除 (`>\s+<` → `><`)
  s = s.replace(/>\s+</g, '><');

  // 5. 連続する空白文字 (改行含む) を 1 つの半角空白に
  s = s.replace(/\s+/g, ' ');

  // 6. 先頭末尾の空白を除去
  s = s.trim();

  return s;
}
