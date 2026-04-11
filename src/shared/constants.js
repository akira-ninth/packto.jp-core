/**
 * Cloudflare Worker 用の共通定数
 *
 * httpdocs/shared/constants.js (AWS 版) と同期させること。
 */

/** imagy 専用クエリパラメータ。オリジンには渡さない。 */
export const IMAGY_PARAM_KEYS = new Set([
  '_avif',  // AVIF 変換オプション (1 で有効)
  '_webp',  // WEBP 変換オプション (1 で有効)
  '_w',     // 横幅リサイズ
  '_h',     // 縦幅リサイズ
  '_q',     // 画質 (1-100)
  '_min',   // text minify 有効化 (Phase 8: imagy-text 用、0 で無効化)
  '_t',     // 処理スルー
  '_lm',    // Last-Modified
  '_nc',    // No-Cache
  '_cc',    // Cache-Control max-age
  '_ck',    // Cache-Key
  '_r',     // リダイレクトキャッシュ回避
  '_now',   // origin リクエストのキャッシュ無効化
  '_vr-a',  // ViewerRequest Abort フラグ
  '_vr-e',  // ViewerRequest Error フラグ
  '_vr-d',  // ViewerRequest Disconnected フラグ
  '_debug', // デバッグログ出力
]);

/** 入力サイズ上限 (Workers 128MB メモリ制約のため AWS 版 40MB から縮小) */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * decode 後の ImageData ピクセル数上限 (source check)。
 * Workers の 128MB メモリ制約での OOM 予防のため decode 直後にチェックする。
 *
 * 16M pixel * 4 byte/pixel ≒ 64MB の ImageData バッファ。
 * resize/encode 中の追加バッファを含めて余裕を持って 128MB 以内に収まる。
 * (例: 4096x4096, 5500x2900 程度の入力まで decode は通る)
 */
export const MAX_INPUT_PIXEL_COUNT = 16 * 1024 * 1024;

/**
 * encoder に渡す output ImageData ピクセル数上限。
 *
 * jSquash の AVIF/WebP encoder は WASM モジュール内部のメモリ制約により
 * 実用上 ~2M pixel あたりで encode が失敗する (Phase 7 検証で実測)。
 * これを超える target は事前に reject し、cryptic な [err] ではなく
 * 明示的な [lrg-out:WxH] を返してオリジンに 301 でフォールバックさせる。
 *
 * 大きい source 画像も _w/_h で縮小すれば この閾値内に収まれば処理できる。
 * (例: 4000x3000 source → _w=800 → 800x600 target → OK)
 */
export const MAX_OUTPUT_PIXEL_COUNT = 2 * 1024 * 1024;

/**
 * Content-Type 許可パターン。
 *
 * AWS 版は jpeg/png/gif のみだが、Cloudflare 版は jSquash で WebP decode が
 * 出来るので入力としても受け付ける (主用途: 既存 WebP 配信から AVIF への移行)。
 */
export const ALLOWED_CONTENT_TYPE_REGEX = /(jpe?g|png|gif|webp)/i;

/**
 * 画像リクエストパスの拡張子許可パターン。
 *
 * Worker は画像/テキスト配信専用であり、HTML/任意ファイルへの open proxy
 * になるのを防ぐため、pathname の末尾がこれらの拡張子でないリクエストは
 * origin に fetch せず即 404 で reject する。
 */
export const ALLOWED_IMAGE_PATH_EXTENSION_REGEX = /\.(jpe?g|png|gif|webp)$/i;

/**
 * テキストリクエストパスの拡張子許可パターン (Phase 10 で imagy worker に統合)。
 */
export const ALLOWED_TEXT_PATH_EXTENSION_REGEX = /\.(js|mjs|css|svg|json)$/i;

/**
 * テキスト用 Content-Type 許可パターン。
 * RFC 4329 旧推奨 (application/javascript) と現行 IETF 推奨 (text/javascript) の両方を許可。
 * SVG は image/svg+xml が正しい MIME。
 */
export const ALLOWED_TEXT_CONTENT_TYPE_REGEX =
  /^(application\/(javascript|ecmascript|json)|text\/(javascript|ecmascript|css)|image\/svg\+xml)/i;

/** デフォルト Cache-Control max-age (秒) */
export const DEFAULT_CACHE_TTL = 360;

/** Worker バージョン (process_history 等に使用) */
export const WORKER_VERSION = 'cf20260408';
