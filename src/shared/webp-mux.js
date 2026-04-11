/**
 * Animated WebP RIFF muxer (Phase 9)
 *
 * @jsquash/webp で個別 encode した複数フレーム (各 RIFF/WEBP 形式) から
 * VP8 / VP8L / ALPH chunk を抽出し、ANMF chunk として束ねた animated WebP
 * RIFF コンテナを組み立てる。
 *
 * libwebp の webpmux ツールに相当する処理を pure JS で行う。
 * 仕様: https://developers.google.com/speed/webp/docs/riff_container
 *
 * Workers (workerd) 上で完結し、追加 WASM 不要。
 */

/**
 * @typedef {Object} WebpFrame
 * @property {Uint8Array} webpBytes - @jsquash/webp が出力した単一フレーム WebP file
 * @property {number} delay - 表示時間 (ms)
 */

/**
 * 複数の単フレーム WebP を束ねて animated WebP を返す。
 *
 * @param {object} args
 * @param {number} args.width - canvas 幅
 * @param {number} args.height - canvas 高さ
 * @param {WebpFrame[]} args.frames
 * @param {number} [args.loopCount] - 0=無限ループ (デフォルト)
 * @returns {Uint8Array} animated WebP のバイト列
 */
export function buildAnimatedWebp({ width, height, frames, loopCount = 0 }) {
  if (!frames.length) {
    throw new Error('animated webp must have at least one frame');
  }
  if (width <= 0 || height <= 0 || width > 0xFFFFFF || height > 0xFFFFFF) {
    throw new Error(`invalid canvas dimensions: ${width}x${height}`);
  }

  // 各フレームの WebP file から bitstream 系の chunks (VP8/VP8L/ALPH) を抽出
  const frameChunkBlobs = frames.map((f) => extractFrameChunks(f.webpBytes));

  // VP8X chunk: feature flags + canvas dimensions
  // bit 1 = alpha, bit 4 = animation。透明度有無に関わらず alpha bit を立てておく
  // (animated GIF→WebP 用途では透明度を含むケースがほとんど)
  const vp8xPayload = new Uint8Array(10);
  vp8xPayload[0] = 0x10 | 0x02; // animation | alpha
  // bytes 1-3 reserved (0)
  writeUint24LE(vp8xPayload, 4, width - 1);
  writeUint24LE(vp8xPayload, 7, height - 1);
  const vp8xChunk = buildChunk('VP8X', vp8xPayload);

  // ANIM chunk: background color (BGRA) + loop count
  const animPayload = new Uint8Array(6);
  // bytes 0-3 = background color BGRA, 0x00000000 (透明) で問題なし
  // bytes 4-5 = loop count (0=無限)
  animPayload[4] = loopCount & 0xFF;
  animPayload[5] = (loopCount >> 8) & 0xFF;
  const animChunk = buildChunk('ANIM', animPayload);

  // ANMF chunks
  const anmfChunks = frames.map((f, i) =>
    buildAnmfChunk({
      frameX: 0,
      frameY: 0,
      frameWidth: width,
      frameHeight: height,
      duration: f.delay,
      blend: 0, // 0 = alpha blend with previous (推奨)
      dispose: 1, // 1 = dispose to background after this frame
      frameData: frameChunkBlobs[i],
    })
  );

  // 全 chunk を結合
  const totalLength = vp8xChunk.length + animChunk.length + anmfChunks.reduce((s, c) => s + c.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  body.set(vp8xChunk, offset); offset += vp8xChunk.length;
  body.set(animChunk, offset); offset += animChunk.length;
  for (const a of anmfChunks) {
    body.set(a, offset);
    offset += a.length;
  }

  // RIFF wrapper
  // RIFF [size] WEBP [body]
  // size は "WEBP" + body のサイズ (RIFF 自身と size 自身は含まない)
  const riffSize = 4 + body.length;
  const file = new Uint8Array(8 + riffSize);
  writeAscii(file, 0, 'RIFF');
  writeUint32LE(file, 4, riffSize);
  writeAscii(file, 8, 'WEBP');
  file.set(body, 12);
  return file;
}

/**
 * 単フレーム WebP file から bitstream 系 chunks (VP8/VP8L/ALPH) を抽出して
 * concat したバイト列を返す。VP8X や RIFF 自身は除外する。
 */
export function extractFrameChunks(webpBytes) {
  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength);

  if (webpBytes.length < 12 || readAscii(webpBytes, 0, 4) !== 'RIFF' || readAscii(webpBytes, 8, 4) !== 'WEBP') {
    throw new Error('not a valid WebP file');
  }

  const out = [];
  let pos = 12;
  while (pos + 8 <= webpBytes.length) {
    const fourcc = readAscii(webpBytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const chunkEnd = pos + 8 + size;
    if (chunkEnd > webpBytes.length) {
      throw new Error(`WebP chunk ${fourcc} truncated`);
    }

    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ALPH') {
      // chunk header (8 bytes) + payload + padding (2-byte align) を込みでコピー
      const padded = chunkEnd + (size & 1); // 奇数サイズなら 1 byte padding
      out.push(webpBytes.subarray(pos, padded));
    }
    // VP8X / その他 (EXIF/XMP/ICCP) はスキップ

    pos = chunkEnd + (size & 1);
  }

  if (out.length === 0) {
    throw new Error('WebP file has no VP8/VP8L/ALPH chunk');
  }

  return concatUint8(out);
}

/**
 * ANMF chunk を組み立てる。
 *
 * @param {object} args
 * @param {number} args.frameX - フレーム X offset (実際は ÷2 されて格納)
 * @param {number} args.frameY - フレーム Y offset (同上)
 * @param {number} args.frameWidth - フレーム幅
 * @param {number} args.frameHeight - フレーム高さ
 * @param {number} args.duration - 表示時間 (ms)
 * @param {0|1} args.blend - 0=blend with previous, 1=overwrite
 * @param {0|1} args.dispose - 0=keep, 1=restore to background
 * @param {Uint8Array} args.frameData - VP8/VP8L/ALPH chunks (chunk header 込み)
 */
function buildAnmfChunk({ frameX, frameY, frameWidth, frameHeight, duration, blend, dispose, frameData }) {
  const payload = new Uint8Array(16 + frameData.length);
  // ANMF spec: frame X/Y は 2 px 単位 (÷2 して格納)
  writeUint24LE(payload, 0, Math.floor(frameX / 2));
  writeUint24LE(payload, 3, Math.floor(frameY / 2));
  writeUint24LE(payload, 6, frameWidth - 1);
  writeUint24LE(payload, 9, frameHeight - 1);
  writeUint24LE(payload, 12, Math.max(0, Math.min(0xFFFFFF, duration | 0)));
  // byte 15: reserved (6 bits) | blend (1 bit) | dispose (1 bit)
  payload[15] = ((blend & 1) << 1) | (dispose & 1);
  payload.set(frameData, 16);
  return buildChunk('ANMF', payload);
}

/**
 * RIFF chunk (4-byte FourCC + 4-byte LE size + payload + 1-byte padding if odd) を構築
 */
function buildChunk(fourcc, payload) {
  const size = payload.length;
  const padded = size + (size & 1);
  const chunk = new Uint8Array(8 + padded);
  writeAscii(chunk, 0, fourcc);
  writeUint32LE(chunk, 4, size);
  chunk.set(payload, 8);
  // padding byte (奇数サイズの場合は 0)
  return chunk;
}

function writeUint32LE(arr, offset, value) {
  arr[offset]     = value & 0xFF;
  arr[offset + 1] = (value >> 8) & 0xFF;
  arr[offset + 2] = (value >> 16) & 0xFF;
  arr[offset + 3] = (value >> 24) & 0xFF;
}

function writeUint24LE(arr, offset, value) {
  arr[offset]     = value & 0xFF;
  arr[offset + 1] = (value >> 8) & 0xFF;
  arr[offset + 2] = (value >> 16) & 0xFF;
}

function writeAscii(arr, offset, str) {
  for (let i = 0; i < str.length; i++) {
    arr[offset + i] = str.charCodeAt(i);
  }
}

function readAscii(arr, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(arr[offset + i]);
  }
  return s;
}

function concatUint8(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
