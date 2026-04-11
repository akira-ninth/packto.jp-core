/**
 * Phase 8 / Phase 10: cloudflare/src/shared/ のテキスト minify 関連ユニットテスト
 *
 * Phase 10 で imagy-text worker が imagy worker に統合されたため、
 * テキスト関連の shared modules も cloudflare/src/shared/ に移設されている。
 *
 * - ALLOWED_TEXT_PATH_EXTENSION_REGEX / ALLOWED_TEXT_CONTENT_TYPE_REGEX
 * - detectTextFormat / textFormatContentType
 * - selectMinifier (dispatch のみ。実 minifier の動作は integration test 側で)
 * - SVG minifier の regex 単体テスト (純粋関数)
 * - JSON minifier の単体テスト (BOM 含む)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TEXT_PATH_EXTENSION_REGEX,
  ALLOWED_TEXT_CONTENT_TYPE_REGEX,
} from '../../src/shared/constants.js';
import {
  detectTextFormat,
  textFormatContentType,
} from '../../src/shared/format.js';
import { selectMinifier } from '../../src/shared/minifiers/index.js';
import { minifySvg } from '../../src/shared/minifiers/svg.js';
import { minifyJson } from '../../src/shared/minifiers/json.js';

describe('ALLOWED_TEXT_PATH_EXTENSION_REGEX', () => {
  const allow = (p) => assert.ok(ALLOWED_TEXT_PATH_EXTENSION_REGEX.test(p), `should allow ${p}`);
  const deny  = (p) => assert.ok(!ALLOWED_TEXT_PATH_EXTENSION_REGEX.test(p), `should deny ${p}`);

  it('.js を許可', () => allow('/foo/app.js'));
  it('.mjs を許可', () => allow('/lib/module.mjs'));
  it('.css を許可', () => allow('/styles/main.css'));
  it('.svg を許可', () => allow('/icons/logo.svg'));
  it('.json を許可', () => allow('/data/config.json'));
  it('.JS (大文字) を許可', () => allow('/foo.JS'));
  it('.html を拒否', () => deny('/index.html'));
  it('.php を拒否', () => deny('/admin.php'));
  it('.jpg を拒否 (画像 worker のスコープ)', () => deny('/photo.jpg'));
  it('.txt を拒否', () => deny('/robots.txt'));
  it('拡張子なしを拒否', () => deny('/api/endpoint'));
  it('ルートパスを拒否', () => deny('/'));
  it('jpg をパス中間に持つだけは拒否', () => deny('/foo.jpg/bar'));
});

describe('ALLOWED_TEXT_CONTENT_TYPE_REGEX', () => {
  const allow = (ct) => assert.ok(ALLOWED_TEXT_CONTENT_TYPE_REGEX.test(ct), `should allow ${ct}`);
  const deny  = (ct) => assert.ok(!ALLOWED_TEXT_CONTENT_TYPE_REGEX.test(ct), `should deny ${ct}`);

  it('application/javascript を許可', () => allow('application/javascript'));
  it('application/javascript; charset=utf-8 を許可', () => allow('application/javascript; charset=utf-8'));
  it('text/javascript を許可', () => allow('text/javascript'));
  it('application/ecmascript を許可', () => allow('application/ecmascript'));
  it('text/css を許可', () => allow('text/css'));
  it('text/css; charset=utf-8 を許可', () => allow('text/css; charset=utf-8'));
  it('application/json を許可', () => allow('application/json'));
  it('image/svg+xml を許可', () => allow('image/svg+xml'));
  it('text/html を拒否', () => deny('text/html'));
  it('image/jpeg を拒否', () => deny('image/jpeg'));
  it('application/octet-stream を拒否', () => deny('application/octet-stream'));
  it('text/xml を拒否 (svg+xml ではない)', () => deny('text/xml'));
});

describe('detectTextFormat', () => {
  it('content-type 優先: javascript', () => {
    assert.equal(detectTextFormat('application/javascript', '/foo'), 'js');
    assert.equal(detectTextFormat('text/javascript', '/foo'), 'js');
  });

  it('content-type 優先: css', () => {
    assert.equal(detectTextFormat('text/css', '/foo'), 'css');
  });

  it('content-type 優先: svg', () => {
    assert.equal(detectTextFormat('image/svg+xml', '/foo'), 'svg');
  });

  it('content-type 優先: json', () => {
    assert.equal(detectTextFormat('application/json', '/foo'), 'json');
  });

  it('content-type なし: pathname フォールバック .js → js', () => {
    assert.equal(detectTextFormat('', '/foo/app.js'), 'js');
  });

  it('content-type なし: pathname フォールバック .mjs → js', () => {
    assert.equal(detectTextFormat('', '/lib/module.mjs'), 'js');
  });

  it('content-type なし: pathname フォールバック .css → css', () => {
    assert.equal(detectTextFormat('', '/styles/main.css'), 'css');
  });

  it('content-type なし: pathname フォールバック .svg → svg', () => {
    assert.equal(detectTextFormat('', '/icons/logo.svg'), 'svg');
  });

  it('content-type なし: pathname フォールバック .json → json', () => {
    assert.equal(detectTextFormat('', '/data/x.json'), 'json');
  });

  it('charset サフィックス付きでも判定可', () => {
    assert.equal(detectTextFormat('text/javascript; charset=utf-8', '/x'), 'js');
  });

  it('未対応: text/html → null', () => {
    assert.equal(detectTextFormat('text/html', '/x'), null);
  });

  it('null content-type, 未対応 path → null', () => {
    assert.equal(detectTextFormat(null, '/foo'), null);
  });
});

describe('textFormatContentType', () => {
  it('js → text/javascript; charset=utf-8', () => {
    assert.equal(textFormatContentType('js'), 'text/javascript; charset=utf-8');
  });
  it('css → text/css; charset=utf-8', () => {
    assert.equal(textFormatContentType('css'), 'text/css; charset=utf-8');
  });
  it('svg → image/svg+xml; charset=utf-8', () => {
    assert.equal(textFormatContentType('svg'), 'image/svg+xml; charset=utf-8');
  });
  it('json → application/json; charset=utf-8', () => {
    assert.equal(textFormatContentType('json'), 'application/json; charset=utf-8');
  });
  it('unknown → application/octet-stream', () => {
    assert.equal(textFormatContentType('unknown'), 'application/octet-stream');
  });
});

describe('selectMinifier dispatch', () => {
  it('js → 関数を返す', () => assert.equal(typeof selectMinifier('js'), 'function'));
  it('css → 関数を返す', () => assert.equal(typeof selectMinifier('css'), 'function'));
  it('svg → 関数を返す', () => assert.equal(typeof selectMinifier('svg'), 'function'));
  it('json → 関数を返す', () => assert.equal(typeof selectMinifier('json'), 'function'));
  it('unknown → null', () => assert.equal(selectMinifier('html'), null));
});

describe('minifySvg (regex 実装)', () => {
  it('XML 宣言を削除', () => {
    const out = minifySvg('<?xml version="1.0"?><svg></svg>');
    assert.ok(!out.includes('<?xml'));
  });

  it('XML コメントを削除', () => {
    const out = minifySvg('<svg><!-- this is a comment --><circle/></svg>');
    assert.ok(!out.includes('comment'));
    assert.ok(out.includes('<circle/>'));
  });

  it('DOCTYPE を削除', () => {
    const out = minifySvg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg></svg>');
    assert.ok(!out.includes('DOCTYPE'));
  });

  it('タグ間の空白を削除', () => {
    const out = minifySvg('<svg>\n  <circle/>\n  <rect/>\n</svg>');
    assert.equal(out, '<svg><circle/><rect/></svg>');
  });

  it('連続空白を 1 つに圧縮', () => {
    const out = minifySvg('<svg     viewBox="0   0   100   100"></svg>');
    assert.ok(!out.includes('   ')); // no triple space
  });

  it('実際のアイコン SVG が短くなる', () => {
    const before = `<?xml version="1.0" encoding="UTF-8"?>
<!-- icon: heart -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <!-- main path -->
  <path d="M12 21s-7-4.5-9-9c-1.5-3.5 1-7 5-7 2 0 3 1 4 2.5 1-1.5 2-2.5 4-2.5 4 0 6.5 3.5 5 7-2 4.5-9 9-9 9z"/>
</svg>`;
    const after = minifySvg(before);
    assert.ok(after.length < before.length);
    assert.ok(after.includes('<path'));
  });
});

describe('minifyJson', () => {
  it('pretty-printed JSON が空白なしになる', () => {
    const input = `{
  "name": "imagy",
  "value": 42
}`;
    const out = minifyJson(input);
    assert.equal(out, '{"name":"imagy","value":42}');
  });

  it('ネストされた配列・オブジェクトも minify される', () => {
    const input = `{ "list": [ 1, 2, { "nested": true } ] }`;
    const out = minifyJson(input);
    assert.equal(out, '{"list":[1,2,{"nested":true}]}');
  });

  it('BOM を含んでも parse 成功', () => {
    const input = '\uFEFF{"key":"value"}';
    const out = minifyJson(input);
    assert.equal(out, '{"key":"value"}');
  });

  it('既に minify 済みでも問題なし', () => {
    const input = '{"a":1}';
    assert.equal(minifyJson(input), '{"a":1}');
  });

  it('不正な JSON は SyntaxError を throw', () => {
    assert.throws(() => minifyJson('{invalid}'));
  });
});

// Phase 10 で worker 統合により TEXT_WORKER_VERSION 廃止 (WORKER_VERSION 共通化)。
// テストもこの describe block ごと不要
