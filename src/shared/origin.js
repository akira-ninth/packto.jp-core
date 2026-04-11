/**
 * 顧客サブドメインからオリジン URL とプランを解決する。
 *
 * Phase 6 の方針:
 * - ホスト名は `<customer>.packto.jp` (例: rays-hd.packto.jp)
 * - customer サブドメインから KV (env.CUSTOMERS) で実オリジンとプランを引く
 * - workers.dev サブドメインや未登録顧客の場合はデフォルトにフォールバック
 *
 * Phase 10 で CUSTOMER_ORIGINS の値型を `string` から `{ origin, plan }` に拡張。
 * Phase 11 で resolveCustomer を **async** にして KV 読み出しに切り替えた。
 * packto-console (Laravel) の AdminCustomerController が KV REST API 経由で
 * このネームスペースに書き込む。CUSTOMER_ORIGINS の hardcode は **KV ミス時の
 * フォールバック** として残置している (worker と Laravel の同期失敗時の保険)。
 */

import { ORIGIN_HOST } from './config.js';

/**
 * Cloudflare 委譲ゾーン (Phase 6 確定値: packto.jp)。
 *
 * 顧客 URL は `<customer>.packto.jp` の形式。
 * imagy.jp は AWS Lambda@Edge 版で運用中の既存顧客が居るため触らず、
 * Cloudflare 版の新ドメインとして packto.jp を取得した。
 */
export const EDGE_ZONE = 'packto.jp';

/**
 * @typedef {import('./plans.js').PlanName} PlanName
 */

/**
 * @typedef {Object} CustomerConfig
 * @property {string} origin - origin URL (例: 'https://rays-hd.com')
 * @property {PlanName} plan - 契約プラン
 */

/**
 * 顧客サブドメイン → CustomerConfig のフォールバック表。
 *
 * Phase 11 以降は KV (env.CUSTOMERS) が一次ソース。この hardcode は
 * **KV から読めなかった場合のフォールバック** として残置:
 *   - KV binding が無い (テスト・workers.dev のローカル検証)
 *   - KV API 呼び出しが失敗した
 *   - KV にまだ書き込まれていない顧客 (移行途中)
 *
 * 通常運用では packto-console から KV に書き込まれた値が使われる。
 *
 * @type {Record<string, CustomerConfig>}
 */
export const CUSTOMER_ORIGINS = {
  'rays-hd': {
    origin: 'https://rays-hd.com',
    plan: 'pro',
  },
};

/**
 * リクエストホスト名から customer サブドメインを抽出する。
 * `rays-hd.cfedge.imagy.jp` → 'rays-hd'
 * `cfedge.imagy.jp` → null (サブドメインなし)
 * 上記以外 (workers.dev 等) → null
 */
export function extractCustomerSubdomain(hostname) {
  const lower = (hostname || '').toLowerCase();
  if (!lower.endsWith(`.${EDGE_ZONE}`)) return null;
  const sub = lower.slice(0, -1 * (`.${EDGE_ZONE}`).length);
  if (!sub || sub.includes('.')) return null; // 1 段だけ受け付ける
  return sub;
}

/**
 * リクエスト URL から CustomerConfig (origin + plan) を解決する。
 *
 * Phase 11 で **async** に変更。env.CUSTOMERS (KV) を一次ソースとして読み、
 * KV ミス・KV エラー時は CUSTOMER_ORIGINS の hardcode にフォールバックする。
 *
 * - <customer>.<EDGE_ZONE> サブドメイン経由
 *   1. KV から `<sub>` キーを読む (env.CUSTOMERS が無ければ skip)
 *   2. KV ヒット → そのまま返す
 *   3. KV ミス or エラー → CUSTOMER_ORIGINS にフォールバック
 *   4. それでも見つからない → null (呼び出し側で 404)
 * - workers.dev / その他 → ORIGIN_HOST + プラン 'pro' (検証用フォールバック)
 *
 * @param {URL} url
 * @param {{ CUSTOMERS?: KVNamespace }} [env]
 * @returns {Promise<CustomerConfig | null>}
 */
export async function resolveCustomer(url, env) {
  const sub = extractCustomerSubdomain(url.hostname);
  if (sub === null) {
    return { origin: ORIGIN_HOST, plan: 'pro' };
  }

  // 1. KV から読む (binding が無い・エラーは静かに hardcode へフォールバック)
  if (env?.CUSTOMERS) {
    try {
      const kvHit = await env.CUSTOMERS.get(sub, { type: 'json' });
      if (kvHit && typeof kvHit.origin === 'string' && typeof kvHit.plan === 'string') {
        return kvHit;
      }
    } catch {
      // KV エラー → hardcode フォールバックに進む
    }
  }

  // 2. hardcode フォールバック
  const cfg = CUSTOMER_ORIGINS[sub];
  if (!cfg) return null;
  return cfg;
}

/**
 * 後方互換: 旧 resolveOrigin() (origin URL のみを返す)。
 *
 * @deprecated Phase 10 以降は resolveCustomer() を使う
 * @param {URL} url
 * @param {{ CUSTOMERS?: KVNamespace }} [env]
 * @returns {Promise<string | null>}
 */
export async function resolveOrigin(url, env) {
  const cfg = await resolveCustomer(url, env);
  return cfg ? cfg.origin : null;
}
