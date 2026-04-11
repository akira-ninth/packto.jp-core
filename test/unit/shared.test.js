/**
 * Cloudflare Worker 共通モジュールのユニットテスト。
 * cloudflare/src/shared/ 配下の純粋関数をテストする。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGY_PARAM_KEYS,
  ALLOWED_CONTENT_TYPE_REGEX,
  ALLOWED_IMAGE_PATH_EXTENSION_REGEX,
  ALLOWED_TEXT_PATH_EXTENSION_REGEX,
  ALLOWED_TEXT_CONTENT_TYPE_REGEX,
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXEL_COUNT,
  MAX_OUTPUT_PIXEL_COUNT,
  DEFAULT_CACHE_TTL,
} from '../../src/shared/constants.js';
import {
  parseDimension,
  parseImagyParams,
  buildOriginUrl,
} from '../../src/shared/querystring.js';
import { buildCacheControl, buildRejectionLocation } from '../../src/shared/headers.js';
import { computeTargetSize } from '../../src/shared/resize.js';
import {
  detectSourceFormat,
  selectFormat,
  resolveQuality,
  formatContentType,
} from '../../src/shared/format.js';
import { DEFAULT_QUALITY, ORIGIN_HOST } from '../../src/shared/config.js';
import {
  EDGE_ZONE,
  CUSTOMER_ORIGINS,
  extractCustomerSubdomain,
  resolveOrigin,
  resolveCustomer,
} from '../../src/shared/origin.js';
import { PLAN_FEATURES, planAllows } from '../../src/shared/plans.js';

describe('IMAGY_PARAM_KEYS', () => {
  it('AWS 版 IMAGY_KEY_LIST と同じキーを含む', () => {
    const expected = [
      '_avif', '_webp', '_w', '_h', '_q', '_min', '_t', '_lm', '_nc', '_cc', '_ck', '_r', '_now',
      '_vr-a', '_vr-e', '_vr-d', '_debug',
    ];
    for (const key of expected) {
      assert.ok(IMAGY_PARAM_KEYS.has(key), `${key} が IMAGY_PARAM_KEYS に含まれていない`);
    }
  });
});

describe('ALLOWED_CONTENT_TYPE_REGEX', () => {
  it('image/jpeg を許可', () => assert.ok(ALLOWED_CONTENT_TYPE_REGEX.test('image/jpeg')));
  it('image/png を許可', () => assert.ok(ALLOWED_CONTENT_TYPE_REGEX.test('image/png')));
  it('image/gif を許可', () => assert.ok(ALLOWED_CONTENT_TYPE_REGEX.test('image/gif')));
  it('image/webp を許可 (Cloudflare 側拡張)', () => assert.ok(ALLOWED_CONTENT_TYPE_REGEX.test('image/webp')));
  it('text/html を拒否', () => assert.ok(!ALLOWED_CONTENT_TYPE_REGEX.test('text/html')));
  it('image/heif を拒否', () => assert.ok(!ALLOWED_CONTENT_TYPE_REGEX.test('image/heif')));
});

describe('ALLOWED_IMAGE_PATH_EXTENSION_REGEX', () => {
  const allow = (p) => assert.ok(ALLOWED_IMAGE_PATH_EXTENSION_REGEX.test(p), `should allow ${p}`);
  const deny  = (p) => assert.ok(!ALLOWED_IMAGE_PATH_EXTENSION_REGEX.test(p), `should deny ${p}`);
  it('.jpg を許可', () => allow('/imgtest/1.jpg'));
  it('.JPG (大文字) を許可', () => allow('/imgtest/1.JPG'));
  it('.jpeg を許可', () => allow('/photo.jpeg'));
  it('.png を許可', () => allow('/img/photo.png'));
  it('.gif を許可', () => allow('/anim.gif'));
  it('.webp を許可', () => allow('/photo.webp'));
  it('.WebP (mixed case) を許可', () => allow('/photo.WebP'));
  it('拡張子なしを拒否', () => deny('/imgtest/photo'));
  it('ルートパスを拒否', () => deny('/'));
  it('.html を拒否', () => deny('/index.html'));
  it('.php を拒否', () => deny('/admin.php'));
  it('.svg を拒否 (jSquash 未対応)', () => deny('/icon.svg'));
  it('.bmp を拒否', () => deny('/old.bmp'));
  it('.txt を拒否', () => deny('/robots.txt'));
  it('jpg をパスの中間に持つだけは拒否', () => deny('/foo.jpg/bar'));
});

describe('parseDimension', () => {
  it('正の整数文字列を整数化する', () => assert.equal(parseDimension('200'), 200));
  it('"0" は無効として null', () => assert.equal(parseDimension('0'), null));
  it('負の値は無効として null', () => assert.equal(parseDimension('-10'), null));
  it('"abc" は無効として null', () => assert.equal(parseDimension('abc'), null));
  it('null は null', () => assert.equal(parseDimension(null), null));
  it('undefined は null', () => assert.equal(parseDimension(undefined), null));
  it('小数は parseInt の挙動に従い切り捨て', () => assert.equal(parseDimension('200.7'), 200));
});

describe('parseImagyParams', () => {
  const sp = (qs) => new URL('https://x.example/img?' + qs).searchParams;

  it('空のクエリ', () => {
    const p = parseImagyParams(sp(''));
    assert.equal(p._w, null);
    assert.equal(p._h, null);
    assert.equal(p._t, false);
    assert.equal(p._nc, false);
    assert.equal(p._debug, false);
  });

  it('_w / _h が parse される', () => {
    const p = parseImagyParams(sp('_w=200&_h=100'));
    assert.equal(p._w, 200);
    assert.equal(p._h, 100);
  });

  it('_w=0 は null として無効化', () => {
    const p = parseImagyParams(sp('_w=0'));
    assert.equal(p._w, null);
  });

  it('_t / _nc / _debug は値なしフラグ', () => {
    const p = parseImagyParams(sp('_t&_nc&_debug'));
    assert.equal(p._t, true);
    assert.equal(p._nc, true);
    assert.equal(p._debug, true);
  });

  it('_cc は文字列で保持', () => {
    const p = parseImagyParams(sp('_cc=600'));
    assert.equal(p._cc, '600');
  });

  it('_min は文字列で保持 (Phase 8: imagy-text 用)', () => {
    assert.equal(parseImagyParams(sp('_min=0'))._min, '0');
    assert.equal(parseImagyParams(sp('_min=1'))._min, '1');
    assert.equal(parseImagyParams(sp(''))._min, undefined);
  });
});

describe('buildOriginUrl', () => {
  it('imagy パラメータを除外する', () => {
    const url = new URL('https://x.example/img/photo.png?_w=200&_avif=1');
    assert.equal(buildOriginUrl(url, 'https://origin.test'), 'https://origin.test/img/photo.png');
  });

  it('imagy 以外のパラメータは保持する', () => {
    const url = new URL('https://x.example/img/photo.png?_w=200&date=210428&v=2');
    assert.equal(
      buildOriginUrl(url, 'https://origin.test'),
      'https://origin.test/img/photo.png?date=210428&v=2',
    );
  });

  it('クエリなしでも動く', () => {
    const url = new URL('https://x.example/img/photo.png');
    assert.equal(buildOriginUrl(url, 'https://origin.test'), 'https://origin.test/img/photo.png');
  });

  it('全てが imagy パラメータならクエリなし URL', () => {
    const url = new URL('https://x.example/img/photo.png?_w=1&_h=1&_avif=1&_q=80&_t&_nc');
    assert.equal(buildOriginUrl(url, 'https://origin.test'), 'https://origin.test/img/photo.png');
  });
});

describe('computeTargetSize', () => {
  it('_w のみ: 横を基準に縦を比例縮小', () => {
    assert.deepEqual(computeTargetSize(540, 160, 100, null), { width: 100, height: 30 });
  });

  it('_h のみ: 縦を基準に横を比例縮小', () => {
    assert.deepEqual(computeTargetSize(540, 160, null, 80), { width: 270, height: 80 });
  });

  it('両方指定: fit:inside (min ratio)', () => {
    assert.deepEqual(computeTargetSize(540, 160, 200, 100), { width: 200, height: 59 });
  });

  it('両方指定で縦が制約に: 縦を基準に縮小', () => {
    assert.deepEqual(computeTargetSize(540, 160, 1000, 80), { width: 270, height: 80 });
  });

  it('指定なし: null', () => {
    assert.equal(computeTargetSize(540, 160, null, null), null);
  });

  it('縦横比 1:1 でも 1px 以上を保証', () => {
    const r = computeTargetSize(1, 100, 1, null);
    assert.ok(r.height >= 1);
  });
});

describe('buildCacheControl', () => {
  it('_nc あり → no-store', () => {
    const c = buildCacheControl({ _nc: true });
    assert.equal(c.value, 'no-store');
    assert.equal(c.historyAppend, '[nc]');
  });

  it('_cc=600 → max-age=600', () => {
    const c = buildCacheControl({ _cc: '600' });
    assert.equal(c.value, 'public, max-age=600');
    assert.equal(c.historyAppend, '[cc]');
  });

  it('_cc 不正値 → デフォルト', () => {
    const c = buildCacheControl({ _cc: 'abc' });
    assert.equal(c.value, `public, max-age=${DEFAULT_CACHE_TTL}`);
    assert.equal(c.historyAppend, '');
  });

  it('指定なし → デフォルト', () => {
    const c = buildCacheControl({});
    assert.equal(c.value, `public, max-age=${DEFAULT_CACHE_TTL}`);
    assert.equal(c.historyAppend, '');
  });

  it('_nc が _cc より優先', () => {
    const c = buildCacheControl({ _nc: true, _cc: '600' });
    assert.equal(c.value, 'no-store');
  });
});

describe('buildRejectionLocation', () => {
  it('_r=<timestamp> を付与する', () => {
    const before = Date.now();
    const loc = buildRejectionLocation('https://origin.test/img/photo.png');
    const url = new URL(loc);
    const r = parseInt(url.searchParams.get('_r'), 10);
    assert.ok(r >= before);
    assert.ok(r <= Date.now() + 1);
  });

  it('既存パラメータを保持しつつ _r を追加', () => {
    const loc = buildRejectionLocation('https://origin.test/img/photo.png?date=210428');
    const url = new URL(loc);
    assert.equal(url.searchParams.get('date'), '210428');
    assert.ok(url.searchParams.has('_r'));
  });
});

describe('MAX_INPUT_BYTES', () => {
  it('10MB に等しい', () => assert.equal(MAX_INPUT_BYTES, 10 * 1024 * 1024));
});

describe('MAX_INPUT_PIXEL_COUNT', () => {
  it('16M ピクセル (Workers 128MB 制約)', () => {
    assert.equal(MAX_INPUT_PIXEL_COUNT, 16 * 1024 * 1024);
  });
  it('4096x4096 はちょうど閾値', () => {
    assert.equal(4096 * 4096, MAX_INPUT_PIXEL_COUNT);
  });
  it('1000x560 (テスト画像 1.jpg) は十分通る', () => {
    assert.ok(1000 * 560 <= MAX_INPUT_PIXEL_COUNT);
  });
  it('5000x5000 (25M ピクセル) は弾く', () => {
    assert.ok(5000 * 5000 > MAX_INPUT_PIXEL_COUNT);
  });
});

describe('MAX_OUTPUT_PIXEL_COUNT', () => {
  it('2M ピクセル (jSquash WASM encoder 実測値)', () => {
    assert.equal(MAX_OUTPUT_PIXEL_COUNT, 2 * 1024 * 1024);
  });
  it('1000x560 (1.jpg 等倍) は通る', () => {
    assert.ok(1000 * 560 <= MAX_OUTPUT_PIXEL_COUNT);
  });
  it('1500x840 (_w=1500 等倍 1.5x upscale) は通る', () => {
    assert.ok(1500 * 840 <= MAX_OUTPUT_PIXEL_COUNT);
  });
  it('2000x1120 (_w=2000) は弾く (実測 AVIF 失敗ライン)', () => {
    assert.ok(2000 * 1120 > MAX_OUTPUT_PIXEL_COUNT);
  });
  it('MAX_INPUT_PIXEL_COUNT より小さい (output 制約の方が厳しい)', () => {
    assert.ok(MAX_OUTPUT_PIXEL_COUNT < MAX_INPUT_PIXEL_COUNT);
  });
});

describe('detectSourceFormat', () => {
  it('image/jpeg → jpeg', () => assert.equal(detectSourceFormat('image/jpeg'), 'jpeg'));
  it('image/jpg → jpeg', () => assert.equal(detectSourceFormat('image/jpg'), 'jpeg'));
  it('image/png → png', () => assert.equal(detectSourceFormat('image/png'), 'png'));
  it('image/gif → gif', () => assert.equal(detectSourceFormat('image/gif'), 'gif'));
  it('image/webp → webp (Cloudflare 側拡張)', () => assert.equal(detectSourceFormat('image/webp'), 'webp'));
  it('image/JPEG (大文字) → jpeg', () => assert.equal(detectSourceFormat('image/JPEG'), 'jpeg'));
  it('image/WebP (大文字) → webp', () => assert.equal(detectSourceFormat('image/WebP'), 'webp'));
  it('image/heif → null', () => assert.equal(detectSourceFormat('image/heif'), null));
  it('text/html → null', () => assert.equal(detectSourceFormat('text/html'), null));
  it('null → null', () => assert.equal(detectSourceFormat(null), null));
});

describe('selectFormat', () => {
  it('_avif=1 が最優先', () => {
    assert.equal(selectFormat({ _avif: '1', _webp: '1' }, 'jpeg'), 'avif');
  });
  it('_webp=1 (avif なし)', () => {
    assert.equal(selectFormat({ _webp: '1' }, 'jpeg'), 'webp');
  });
  it('_avif=0 は AVIF 選択しない', () => {
    assert.equal(selectFormat({ _avif: '0' }, 'jpeg'), 'jpeg');
  });
  it('指定なし → 元フォーマット (jpeg)', () => {
    assert.equal(selectFormat({}, 'jpeg'), 'jpeg');
  });
  it('指定なし → 元フォーマット (png)', () => {
    assert.equal(selectFormat({}, 'png'), 'png');
  });
  it('指定なし → 元フォーマット (webp)', () => {
    assert.equal(selectFormat({}, 'webp'), 'webp');
  });
  it('webp 入力 + _avif=1 → avif (主用途)', () => {
    assert.equal(selectFormat({ _avif: '1' }, 'webp'), 'avif');
  });
  it('Accept: image/avif → avif (自動判別)', () => {
    assert.equal(selectFormat({}, 'jpeg', 'image/avif,image/webp,image/apng,*/*'), 'avif');
  });
  it('Accept: image/webp (avif なし) → webp', () => {
    assert.equal(selectFormat({}, 'jpeg', 'image/webp,image/apng,*/*'), 'webp');
  });
  it('Accept: avif でも _webp=1 パラメータ優先', () => {
    assert.equal(selectFormat({ _webp: '1' }, 'jpeg', 'image/avif,image/webp,*/*'), 'webp');
  });
  it('Accept: avif でも GIF は変換しない', () => {
    assert.equal(selectFormat({}, 'gif', 'image/avif,image/webp,*/*'), 'gif');
  });
  it('Accept ヘッダーなし → 元フォーマット', () => {
    assert.equal(selectFormat({}, 'png', undefined), 'png');
  });
});

describe('resolveQuality', () => {
  it('_q が有効値ならその値', () => {
    assert.equal(resolveQuality('80', 'jpeg'), 80);
    assert.equal(resolveQuality('1', 'avif'), 1);
    assert.equal(resolveQuality('100', 'webp'), 100);
  });
  it('_q が範囲外なら無視', () => {
    assert.equal(resolveQuality('0', 'jpeg'), DEFAULT_QUALITY.jpeg);
    assert.equal(resolveQuality('101', 'jpeg'), DEFAULT_QUALITY.jpeg);
    assert.equal(resolveQuality('-5', 'jpeg'), DEFAULT_QUALITY.jpeg);
  });
  it('_q 未指定 → デフォルト', () => {
    assert.equal(resolveQuality(undefined, 'avif'), DEFAULT_QUALITY.avif);
    assert.equal(resolveQuality(undefined, 'webp'), DEFAULT_QUALITY.webp);
    assert.equal(resolveQuality(undefined, 'jpeg'), DEFAULT_QUALITY.jpeg);
  });
  it('_q 不正文字列 → デフォルト', () => {
    assert.equal(resolveQuality('abc', 'jpeg'), DEFAULT_QUALITY.jpeg);
  });
});

describe('formatContentType', () => {
  it('avif', () => assert.equal(formatContentType('avif'), 'image/avif'));
  it('webp', () => assert.equal(formatContentType('webp'), 'image/webp'));
  it('jpeg', () => assert.equal(formatContentType('jpeg'), 'image/jpeg'));
  it('png',  () => assert.equal(formatContentType('png'),  'image/png'));
  it('gif',  () => assert.equal(formatContentType('gif'),  'image/gif'));
});

describe('extractCustomerSubdomain', () => {
  it('rays-hd.packto.jp → rays-hd', () => {
    assert.equal(extractCustomerSubdomain('rays-hd.packto.jp'), 'rays-hd');
  });
  it('大文字も小文字化', () => {
    assert.equal(extractCustomerSubdomain('Rays-HD.packto.jp'), 'rays-hd');
  });
  it('ゾーン直下 (packto.jp 自身) → null', () => {
    assert.equal(extractCustomerSubdomain('packto.jp'), null);
  });
  it('多段サブドメインは受け付けない', () => {
    assert.equal(extractCustomerSubdomain('a.b.packto.jp'), null);
  });
  it('workers.dev → null', () => {
    assert.equal(extractCustomerSubdomain('imagy.ninth-technologies.workers.dev'), null);
  });
  it('別ドメイン → null', () => {
    assert.equal(extractCustomerSubdomain('rays-hd.example.com'), null);
  });
  it('空文字列 → null', () => {
    assert.equal(extractCustomerSubdomain(''), null);
  });
});

describe('resolveOrigin (legacy interface, Phase 11 で async 化)', () => {
  it('登録済み顧客 (rays-hd) → CUSTOMER_ORIGINS の origin 値', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    assert.equal(await resolveOrigin(url), CUSTOMER_ORIGINS['rays-hd'].origin);
  });
  it('未登録顧客 → null (呼び出し側で reject)', async () => {
    const url = new URL('https://unknown.packto.jp/photo.png');
    assert.equal(await resolveOrigin(url), null);
  });
  it('workers.dev → デフォルト ORIGIN_HOST にフォールバック', async () => {
    const url = new URL('https://imagy.ninth-technologies.workers.dev/photo.png');
    assert.equal(await resolveOrigin(url), ORIGIN_HOST);
  });
  it('packto.jp 自身 → デフォルト (subdomain なし)', async () => {
    const url = new URL('https://packto.jp/photo.png');
    assert.equal(await resolveOrigin(url), ORIGIN_HOST);
  });
});

describe('resolveCustomer (Phase 10/11, async + KV)', () => {
  it('env 無しで 登録済み顧客 → hardcode フォールバック', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    const cfg = await resolveCustomer(url);
    assert.deepEqual(cfg, { origin: 'https://rays-hd.com', plan: 'pro' });
  });
  it('env 無しで 未登録顧客 → null', async () => {
    const url = new URL('https://unknown.packto.jp/photo.png');
    assert.equal(await resolveCustomer(url), null);
  });
  it('workers.dev → フォールバック { ORIGIN_HOST, plan: pro }', async () => {
    const url = new URL('https://imagy.ninth-technologies.workers.dev/photo.png');
    const cfg = await resolveCustomer(url);
    assert.equal(cfg.origin, ORIGIN_HOST);
    assert.equal(cfg.plan, 'pro');
  });
  it('packto.jp 自身 (subdomain なし) → フォールバック', async () => {
    const url = new URL('https://packto.jp/photo.png');
    const cfg = await resolveCustomer(url);
    assert.equal(cfg.plan, 'pro');
  });

  it('KV ヒット → KV 値を優先 (hardcode 上書き)', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    const fakeEnv = {
      CUSTOMERS: {
        get: async (key, opts) => {
          assert.equal(key, 'rays-hd');
          assert.deepEqual(opts, { type: 'json' });
          return { origin: 'https://kv-override.example.com', plan: 'basic' };
        },
      },
    };
    const cfg = await resolveCustomer(url, fakeEnv);
    assert.deepEqual(cfg, { origin: 'https://kv-override.example.com', plan: 'basic' });
  });

  it('KV ミス (null) → hardcode フォールバック', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    const fakeEnv = { CUSTOMERS: { get: async () => null } };
    const cfg = await resolveCustomer(url, fakeEnv);
    assert.deepEqual(cfg, { origin: 'https://rays-hd.com', plan: 'pro' });
  });

  it('KV エラー → hardcode フォールバック', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    const fakeEnv = { CUSTOMERS: { get: async () => { throw new Error('kv down'); } } };
    const cfg = await resolveCustomer(url, fakeEnv);
    assert.deepEqual(cfg, { origin: 'https://rays-hd.com', plan: 'pro' });
  });

  it('KV ヒットだが値が壊れている (origin 欠落) → hardcode フォールバック', async () => {
    const url = new URL('https://rays-hd.packto.jp/photo.png');
    const fakeEnv = { CUSTOMERS: { get: async () => ({ plan: 'pro' }) } };
    const cfg = await resolveCustomer(url, fakeEnv);
    assert.deepEqual(cfg, { origin: 'https://rays-hd.com', plan: 'pro' });
  });

  it('KV に新規顧客あり (hardcode に無い) → KV 値を返す', async () => {
    const url = new URL('https://newco.packto.jp/photo.png');
    const fakeEnv = {
      CUSTOMERS: {
        get: async () => ({ origin: 'https://newco.example.com', plan: 'pro' }),
      },
    };
    const cfg = await resolveCustomer(url, fakeEnv);
    assert.deepEqual(cfg, { origin: 'https://newco.example.com', plan: 'pro' });
  });
});

describe('PLAN_FEATURES', () => {
  it('basic は image: true / text: false', () => {
    assert.equal(PLAN_FEATURES.basic.image, true);
    assert.equal(PLAN_FEATURES.basic.text, false);
  });
  it('pro は image: true / text: true', () => {
    assert.equal(PLAN_FEATURES.pro.image, true);
    assert.equal(PLAN_FEATURES.pro.text, true);
  });
});

describe('planAllows', () => {
  it('basic + image → true', () => assert.equal(planAllows('basic', 'image'), true));
  it('basic + text → false', () => assert.equal(planAllows('basic', 'text'), false));
  it('pro + image → true',   () => assert.equal(planAllows('pro', 'image'), true));
  it('pro + text → true',    () => assert.equal(planAllows('pro', 'text'), true));
  it('未知プラン → false (fail-closed)', () => {
    assert.equal(planAllows('enterprise', 'image'), false);
  });
  it('未知 feature → false', () => {
    assert.equal(planAllows('pro', 'video'), false);
  });
});

describe('EDGE_ZONE', () => {
  it('packto.jp に固定 (Phase 6)', () => assert.equal(EDGE_ZONE, 'packto.jp'));
});
