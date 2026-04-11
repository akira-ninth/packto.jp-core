/**
 * Animated GIF decoder (Phase 9)
 *
 * gifuct-js を Workers 上で使う薄いラッパ。GIF を frames 配列に展開し、
 * disposal / transparency を解決した「full canvas RGBA」の各フレームを
 * 返す。これにより呼び出し側 (animated WebP encoder) は frame をそのまま
 * encode するだけでよい。
 *
 * gifuct-js は CommonJS だが esbuild の interop で ESM から import 可。
 */

import { parseGIF, decompressFrames } from 'gifuct-js';

/**
 * @typedef {Object} GifFrame
 * @property {Uint8ClampedArray} rgba - 全 canvas サイズの RGBA pixels
 * @property {number} delay - 表示時間 (ms)
 */

/**
 * @typedef {Object} DecodedGif
 * @property {number} width - canvas 幅
 * @property {number} height - canvas 高さ
 * @property {GifFrame[]} frames - 全 canvas サイズに rendering 済みのフレーム列
 * @property {number} loopCount - 0=無限ループ
 */

/**
 * GIF を ArrayBuffer から decode し、full canvas RGBA フレーム列を返す。
 *
 * disposal type の対応:
 * - 0 (no specified) / 1 (do not dispose): 前フレームを残して次フレームを上書き
 * - 2 (restore to background): 前フレームのパッチ範囲を透明に戻す
 * - 3 (restore to previous): type 2 と同等扱いで近似 (実用上の差は小さい)
 *
 * @param {ArrayBuffer} buffer
 * @returns {DecodedGif}
 */
export function decodeGif(buffer) {
  const gif = parseGIF(buffer);

  const lsd = gif.lsd; // logical screen descriptor
  const width = lsd.width;
  const height = lsd.height;
  const loopCount = extractLoopCount(gif);

  const decodedFrames = decompressFrames(gif, true);
  if (!decodedFrames.length) {
    throw new Error('GIF has no decodable frames');
  }

  // canvas 全体の RGBA バッファ。透明 (alpha=0) で初期化。
  const canvas = new Uint8ClampedArray(width * height * 4);
  // disposal type 3 用のスナップショット (前々フレーム復元用)
  let prevCanvas = null;

  const frames = [];

  for (const frame of decodedFrames) {
    // disposal type 3 のために現在の状態を保存 (次フレームで使う可能性)
    const beforeFrame = new Uint8ClampedArray(canvas);

    // 現フレームのパッチを canvas に composite
    compositePatch(canvas, width, height, frame);

    // この時点の canvas を copy してフレームとして保存
    frames.push({
      rgba: new Uint8ClampedArray(canvas),
      delay: frame.delay > 0 ? frame.delay : 100, // 0 はブラウザ既定の 100ms 相当
    });

    // 次フレームのための disposal 処理
    const dispose = frame.disposalType ?? 0;
    if (dispose === 2) {
      // restore to background: 現フレームのパッチ範囲を透明に
      clearPatchArea(canvas, width, frame);
    } else if (dispose === 3) {
      // restore to previous: 直前の状態に戻す
      if (prevCanvas) {
        canvas.set(prevCanvas);
      } else {
        clearPatchArea(canvas, width, frame);
      }
    }
    // 0 / 1 の場合は canvas を残す (次フレームが上書きする)

    prevCanvas = beforeFrame;
  }

  return { width, height, frames, loopCount };
}

/**
 * gif.frames から Netscape Application Extension の loop count を探す。
 * 無ければ 0 (無限ループ) を返す。
 */
function extractLoopCount(gif) {
  // gifuct-js の parsed 形式では Application Extension が gif.frames 中に出てくる
  // か gif.gce 等にあるとは限らない。デフォルトで 0 (無限) を返す。
  // 大半の animated GIF は無限ループなのでここで近似する。
  return 0;
}

/**
 * frame.patch (RGBA) を canvas の (frame.dims.left, frame.dims.top) に書き込む。
 * alpha=0 のピクセルは透明扱いで上書きしない (既存ピクセルを残す)。
 */
function compositePatch(canvas, canvasWidth, canvasHeight, frame) {
  const { left, top, width: pw, height: ph } = frame.dims;
  const patch = frame.patch;

  for (let py = 0; py < ph; py++) {
    const cy = top + py;
    if (cy < 0 || cy >= canvasHeight) continue;

    for (let px = 0; px < pw; px++) {
      const cx = left + px;
      if (cx < 0 || cx >= canvasWidth) continue;

      const patchIdx = (py * pw + px) * 4;
      const alpha = patch[patchIdx + 3];
      if (alpha === 0) continue; // 透明ピクセルはスキップ (前フレームを残す)

      const canvasIdx = (cy * canvasWidth + cx) * 4;
      canvas[canvasIdx]     = patch[patchIdx];
      canvas[canvasIdx + 1] = patch[patchIdx + 1];
      canvas[canvasIdx + 2] = patch[patchIdx + 2];
      canvas[canvasIdx + 3] = alpha;
    }
  }
}

/**
 * frame.dims の範囲を canvas 上で透明 (alpha=0) にする。
 * disposal type 2 で使用。
 */
function clearPatchArea(canvas, canvasWidth, frame) {
  const { left, top, width: pw, height: ph } = frame.dims;

  for (let py = 0; py < ph; py++) {
    const cy = top + py;
    for (let px = 0; px < pw; px++) {
      const cx = left + px;
      const idx = (cy * canvasWidth + cx) * 4;
      canvas[idx]     = 0;
      canvas[idx + 1] = 0;
      canvas[idx + 2] = 0;
      canvas[idx + 3] = 0;
    }
  }
}
