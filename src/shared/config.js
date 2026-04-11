/**
 * Cloudflare Worker 用の設定値
 *
 * AWS Lambda@Edge と異なり Workers は環境変数を bindings 経由で渡せるが、
 * 現状は AWS 版と同じく定数で持つ。Phase 6 でカスタムドメイン対応時に
 * 顧客別設定を分離する想定。
 */

/** 初期オリジン (Phase 6 で動的解決に変更予定) */
export const ORIGIN_HOST = 'https://rays-hd.com';

/**
 * 全体タイムアウト (ms)。AWS 版 OR_TIMEOUT_MS と同等。
 * Workers Paid の CPU 制限 30s 以内に収める。
 */
export const TOTAL_TIMEOUT_MS = 28000;

/** オリジンへの fetch タイムアウト (ms)。AWS 版 OR_FETCH_TIMEOUT_MS と同等。 */
export const FETCH_TIMEOUT_MS = 26000;

/** AVIF エンコード設定 */
export const AVIF_OPTIONS = {
  quality: 65,
  speed: 10,
};

/** デフォルト品質 (Phase 5 - AWS 版 config.js と揃える) */
export const DEFAULT_QUALITY = {
  avif: 65,  // AVIF_QUALITY
  webp: 75,  // WEBP_QUALITY
  jpeg: 65,  // JPEG_QUALITY
};

/** WebP encode method (0=最速, 6=最遅。AWS sharp は effort=5 だが Workers ではバランス重視で 4) */
export const WEBP_METHOD = 4;

/** JPEG encode 設定 (mozjpeg) */
export const JPEG_ENCODE_OPTIONS = {
  progressive: true,
  optimize_coding: true,
};
