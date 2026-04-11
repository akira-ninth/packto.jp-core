/**
 * Phase 9: cloudflare/src/shared/webp-mux.js のユニットテスト
 *
 * 自前 RIFF muxer の動作を、合成データ (synthetic VP8 chunks) を使って検証する。
 * 実際の WebP encoder は使わない (それは integration test 側の責務)。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnimatedWebp,
  extractFrameChunks,
} from '../../src/shared/webp-mux.js';

/**
 * 合成 VP8 chunk 入りの最小 WebP file を生成。
 * テスト用なので bitstream は適当な dummy bytes でよい (RIFF parser は中身を解釈しない)。
 */
function makeFakeWebp(vp8DataLen) {
  // RIFF [size] WEBP VP8 [chunkSize] [data]
  const totalSize = 4 + 8 + vp8DataLen + (vp8DataLen & 1); // WEBP + chunk header + data + padding
  const buf = new Uint8Array(8 + totalSize);
  let off = 0;
  // 'RIFF'
  buf[off++] = 0x52; buf[off++] = 0x49; buf[off++] = 0x46; buf[off++] = 0x46;
  // size LE
  buf[off++] = totalSize & 0xFF;
  buf[off++] = (totalSize >> 8) & 0xFF;
  buf[off++] = (totalSize >> 16) & 0xFF;
  buf[off++] = (totalSize >> 24) & 0xFF;
  // 'WEBP'
  buf[off++] = 0x57; buf[off++] = 0x45; buf[off++] = 0x42; buf[off++] = 0x50;
  // 'VP8 '
  buf[off++] = 0x56; buf[off++] = 0x50; buf[off++] = 0x38; buf[off++] = 0x20;
  // chunk size LE
  buf[off++] = vp8DataLen & 0xFF;
  buf[off++] = (vp8DataLen >> 8) & 0xFF;
  buf[off++] = (vp8DataLen >> 16) & 0xFF;
  buf[off++] = (vp8DataLen >> 24) & 0xFF;
  // dummy data
  for (let i = 0; i < vp8DataLen; i++) buf[off++] = 0xAA;
  // 奇数サイズなら padding は既に 0
  return buf;
}

function readFourCC(buf, offset) {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}

function readUint32LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function readUint24LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

describe('extractFrameChunks', () => {
  it('VP8 chunk を抽出する', () => {
    const fake = makeFakeWebp(20);
    const extracted = extractFrameChunks(fake);
    // chunk header (8) + data (20) = 28 bytes
    assert.equal(extracted.length, 28);
    assert.equal(readFourCC(extracted, 0), 'VP8 ');
    assert.equal(readUint32LE(extracted, 4), 20);
  });

  it('奇数サイズの chunk は padding 込みで返す', () => {
    const fake = makeFakeWebp(15); // 奇数
    const extracted = extractFrameChunks(fake);
    // chunk header (8) + data (15) + padding (1) = 24 bytes
    assert.equal(extracted.length, 24);
  });

  it('"RIFF" 以外で始まる入力は throw', () => {
    const bad = new Uint8Array(20);
    assert.throws(() => extractFrameChunks(bad));
  });

  it('VP8/VP8L/ALPH chunk が無い WebP は throw', () => {
    // VP8X chunk のみの (VP8 無し) WebP を生成 → extract で throw
    const buf = new Uint8Array(8 + 4 + 8 + 10);
    let off = 0;
    'RIFF'.split('').forEach(c => { buf[off++] = c.charCodeAt(0); });
    const sz = 4 + 8 + 10;
    buf[off++] = sz & 0xFF; buf[off++] = (sz >> 8) & 0xFF; buf[off++] = (sz >> 16) & 0xFF; buf[off++] = (sz >> 24) & 0xFF;
    'WEBP'.split('').forEach(c => { buf[off++] = c.charCodeAt(0); });
    'VP8X'.split('').forEach(c => { buf[off++] = c.charCodeAt(0); });
    buf[off++] = 10; buf[off++] = 0; buf[off++] = 0; buf[off++] = 0; // size 10
    // 10 bytes payload (zeros)
    assert.throws(() => extractFrameChunks(buf));
  });
});

describe('buildAnimatedWebp', () => {
  it('basic 2-frame の RIFF 構造を組み立てる', () => {
    const f1 = makeFakeWebp(10);
    const f2 = makeFakeWebp(10);
    const out = buildAnimatedWebp({
      width: 32,
      height: 24,
      frames: [
        { webpBytes: f1, delay: 100 },
        { webpBytes: f2, delay: 150 },
      ],
      loopCount: 0,
    });

    assert.equal(readFourCC(out, 0), 'RIFF');
    assert.equal(readFourCC(out, 8), 'WEBP');

    // VP8X chunk が次に来るはず
    assert.equal(readFourCC(out, 12), 'VP8X');
    const vp8xSize = readUint32LE(out, 16);
    assert.equal(vp8xSize, 10);
    // feature flags: 0x10 (animation) | 0x02 (alpha) = 0x12
    assert.equal(out[20], 0x12);
    // canvas dimensions: width-1 = 31, height-1 = 23
    assert.equal(readUint24LE(out, 24), 31);
    assert.equal(readUint24LE(out, 27), 23);
  });

  it('ANIM chunk の loopCount が正しく書かれる', () => {
    const f = makeFakeWebp(10);
    const out = buildAnimatedWebp({
      width: 10,
      height: 10,
      frames: [{ webpBytes: f, delay: 100 }],
      loopCount: 3,
    });

    // VP8X (8 + 10) + ANIM (8 + 6) = pos 30 〜 RIFF 12 から
    // VP8X: 12 + 8 + 10 = 30
    // ANIM: 30
    assert.equal(readFourCC(out, 30), 'ANIM');
    assert.equal(readUint32LE(out, 34), 6);
    // bg color BGRA at 38..41 (zeros), loop count at 42..43
    assert.equal(out[42], 3);
    assert.equal(out[43], 0);
  });

  it('ANMF chunk が フレーム数だけ含まれる', () => {
    const f1 = makeFakeWebp(8);
    const f2 = makeFakeWebp(8);
    const f3 = makeFakeWebp(8);
    const out = buildAnimatedWebp({
      width: 16,
      height: 16,
      frames: [
        { webpBytes: f1, delay: 50 },
        { webpBytes: f2, delay: 50 },
        { webpBytes: f3, delay: 50 },
      ],
    });

    // 全 ANMF を walk
    let pos = 12; // skip RIFF + WEBP
    let anmfCount = 0;
    while (pos + 8 <= out.length) {
      const fourcc = readFourCC(out, pos);
      const size = readUint32LE(out, pos + 4);
      if (fourcc === 'ANMF') anmfCount++;
      pos += 8 + size + (size & 1);
    }
    assert.equal(anmfCount, 3);
  });

  it('ANMF chunk の duration が正しく書かれる', () => {
    const f = makeFakeWebp(8);
    const out = buildAnimatedWebp({
      width: 8,
      height: 8,
      frames: [{ webpBytes: f, delay: 250 }],
    });

    // VP8X (18) + ANIM (14) → ANMF starts at 12 + 18 + 14 = 44
    assert.equal(readFourCC(out, 44), 'ANMF');
    // ANMF payload starts at 44 + 8 = 52
    // bytes 12-14 of payload = duration = 250
    assert.equal(readUint24LE(out, 52 + 12), 250);
  });

  it('frames が空なら throw', () => {
    assert.throws(() =>
      buildAnimatedWebp({ width: 10, height: 10, frames: [] })
    );
  });

  it('canvas が大きすぎる場合 throw', () => {
    const f = makeFakeWebp(8);
    assert.throws(() =>
      buildAnimatedWebp({ width: 0x1000000, height: 10, frames: [{ webpBytes: f, delay: 100 }] })
    );
  });

  it('出力全体が valid な RIFF/WEBP として walk できる', () => {
    const f1 = makeFakeWebp(12);
    const f2 = makeFakeWebp(12);
    const out = buildAnimatedWebp({
      width: 20, height: 20,
      frames: [
        { webpBytes: f1, delay: 80 },
        { webpBytes: f2, delay: 80 },
      ],
    });
    // RIFF size matches actual byte length
    const declaredRiffSize = readUint32LE(out, 4);
    assert.equal(declaredRiffSize + 8, out.length);
    // walk all chunks and ensure no overflow
    let pos = 12;
    while (pos + 8 <= out.length) {
      const size = readUint32LE(out, pos + 4);
      pos += 8 + size + (size & 1);
    }
    assert.equal(pos, out.length);
  });
});
