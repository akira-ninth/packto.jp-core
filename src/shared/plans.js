/**
 * プラン定義 (Phase 10)
 *
 * 顧客プランごとに使える機能を制御する。
 * 新プランや新機能を追加するときはここに 1 行加えるだけで済むよう、
 * 静的 map ベースのシンプルな設計にしてある。
 *
 * 将来 EC2 管理画面 → Cloudflare KV/D1 経由で動的にプランを読む形に
 * 移行する場合は、この PLAN_FEATURES を KV から取り出すヘルパに
 * 差し替えるだけでよい (interface は planAllows() に集約)。
 */

/**
 * @typedef {'basic'|'pro'} PlanName
 */

/**
 * @typedef {Object} PlanFeatures
 * @property {boolean} image - 画像最適化 (jpeg/png/gif/webp の AVIF/WebP/resize 等)
 * @property {boolean} text  - テキスト minify (js/mjs/css/svg/json)
 */

/**
 * プラン → 機能フラグ
 *
 * 現状は 2 段階:
 * - basic: 画像最適化のみ
 * - pro:   画像最適化 + テキスト minify
 *
 * 将来の追加候補:
 * - free:       画像基本のみ (AVIF 不可、resize 不可)
 * - enterprise: pro + 専用機能 (HTML rewriter 等)
 *
 * @type {Record<PlanName, PlanFeatures>}
 */
export const PLAN_FEATURES = {
  basic: {
    image: true,
    text:  false,
  },
  pro: {
    image: true,
    text:  true,
  },
};

/**
 * 指定プランで指定機能が有効かを返す。
 * 不明プラン・不明機能は false (fail-closed)。
 *
 * @param {string} plan
 * @param {keyof PlanFeatures} feature
 * @returns {boolean}
 */
export function planAllows(plan, feature) {
  const def = PLAN_FEATURES[plan];
  if (!def) return false;
  return def[feature] === true;
}
