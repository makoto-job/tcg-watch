/**
 * test/sources-health.test.js — 情報源の設定ファイルの健全性（ネットワーク不要）
 *
 * 目的は「収集が静かに死ぬのを防ぐ」こと。
 *
 * このbotの情報源はコードではなく config/*.json に書いてある。
 * 正規表現が1文字壊れただけでそのサイトは黙って0件になり、しかも
 * 「取得0件 — サイト構造が変わった可能性」という同じ warn しか出ないので、
 * 設定ミスと本物の構造変更の区別がつかなくなる。
 * それを起こさないための静的検査をここに置く。
 *
 * 検査するのは4点:
 *   1. 全サイトの正規表現（itemPattern 等）がコンパイルできること
 *   2. enabled:true のサイトに必須キーが揃っていること（type ごとに違う）
 *   3. expectEmpty が付いているサイトは、なぜ0件が正常なのかが note に書いてあること
 *   4. id が一意であること（重複すると片方の実測結果が上書きされて消える）
 *
 * ネットワークには一切出ない。実サイトの構造が変わったかどうかはここでは分からない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OFFICIAL_PATH = new URL('../config/official-sites.json', import.meta.url);
const SHOPS_PATH = new URL('../config/shop-sources.json', import.meta.url);
const SOURCES_PATH = new URL('../config/sources.json', import.meta.url);

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

const official = readJson(OFFICIAL_PATH);
const shops = readJson(SHOPS_PATH);
const sources = readJson(SOURCES_PATH);

/** 検査対象を1つの配列にまとめる（どのファイルの何番目かを言えるようにする） */
const ALL_SITES = [
  ...official.sites.map((site, i) => ({ file: 'config/official-sites.json', i, site })),
  ...shops.sites.map((site, i) => ({ file: 'config/shop-sources.json', i, site })),
];

/** 設定に正規表現として書かれうるキー。ここに挙げたものは必ずコンパイル検査する */
const REGEX_KEYS = [
  'itemPattern',
  'entryPattern',
  'linkPattern',
  'titlePattern',
  'datePattern',
  'deadlinePattern',
  'destLabelPattern',
  'titleFilter',
  'titleExclude',
  'stockExclude',
  'urlFilter',
  'urlExclude',
];

const where = (entry) => `${entry.file} [${entry.i}] ${entry.site && entry.site.id}`;

/* ------------------------------------------------------------------ */
/* 1. 正規表現がコンパイルできること                                    */
/* ------------------------------------------------------------------ */

test('全サイト: 設定された正規表現が全てコンパイルできる', () => {
  for (const entry of ALL_SITES) {
    for (const key of REGEX_KEYS) {
      const raw = entry.site[key];
      if (raw === undefined || raw === null || raw === '') continue;
      assert.equal(
        typeof raw,
        'string',
        `${where(entry)} の ${key} は文字列で書くこと（実際: ${typeof raw}）`
      );
      assert.doesNotThrow(
        () => new RegExp(raw),
        `${where(entry)} の ${key} がコンパイルできない: ${raw}`
      );
      // src/sources/*.js は itemPattern を 'g' 付きで使う。'g' でも壊れないこと
      assert.doesNotThrow(
        () => new RegExp(raw, 'g'),
        `${where(entry)} の ${key} が 'g' フラグ付きでコンパイルできない: ${raw}`
      );
    }
  }
});

test('全サイト: 正規表現に空にマッチしうるパターンを使っていない', () => {
  // itemPattern が空文字にマッチすると iterateMatches が同じ位置を回り続ける。
  // 暴走ガード（guard 5000）はあるが、そもそも書かないほうがよい。
  for (const entry of ALL_SITES) {
    const raw = entry.site.itemPattern;
    if (!raw) continue;
    const re = new RegExp(raw);
    assert.equal(
      re.test(''),
      false,
      `${where(entry)} の itemPattern が空文字にマッチする: ${raw}`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. enabled:true のサイトに必須キーが揃っていること                   */
/* ------------------------------------------------------------------ */

/** type ごとの必須キー。html-grouped は entryPattern も要る */
const REQUIRED_BY_TYPE = {
  html: ['itemPattern'],
  'html-grouped': ['itemPattern', 'entryPattern'],
  json: ['listKey', 'titleKey', 'pathKey'],
  rss: [],
};

const KNOWN_TYPES = Object.keys(REQUIRED_BY_TYPE);

const enabledSites = ALL_SITES.filter((e) => e.site && e.site.enabled !== false);

test('enabled:true のサイト: 共通の必須キー（id / name / url / type）が揃っている', () => {
  for (const entry of enabledSites) {
    const s = entry.site;
    for (const key of ['id', 'name', 'url', 'type']) {
      assert.ok(
        typeof s[key] === 'string' && s[key].trim() !== '',
        `${where(entry)} に ${key} が無い（enabled:true なら必須）`
      );
    }
    assert.ok(
      KNOWN_TYPES.includes(s.type),
      `${where(entry)} の type が未知の値: ${s.type}（既知: ${KNOWN_TYPES.join(', ')}）`
    );
    // ips は必ず配列で持つ。ただし中身の要否はファイルで違う:
    //   公式サイトは1サイト=1IPが原則なので空は許さない
    //   小売店はジャンル横断の一覧が多く、IPはタイトルから判定するので空でよい
    //   （src/sources/shops.js「店によっては ips が空で来る」参照）
    assert.ok(Array.isArray(s.ips), `${where(entry)} の ips が配列でない`);
    if (entry.file === 'config/official-sites.json') {
      assert.ok(
        s.ips.length > 0,
        `${where(entry)} に ips が無い（公式サイトはどのIPの情報源か分かるはず）`
      );
    }
  }
});

test('enabled:true のサイト: url が http(s) か {env:...} を含む形になっている', () => {
  for (const entry of enabledSites) {
    const url = entry.site.url;
    assert.ok(
      /^https?:\/\//.test(url),
      `${where(entry)} の url が http(s) で始まっていない: ${url}`
    );
    // 環境変数の穴が閉じていない書き方（{env:} や {ENV:...}）を弾く
    for (const m of url.matchAll(/\{([^}]*)\}/g)) {
      assert.match(
        m[1],
        /^env:[A-Za-z_][A-Za-z0-9_]*$/,
        `${where(entry)} の url にある差し込み {${m[1]}} は {env:NAME} 形式ではない`
      );
    }
  }
});

test('enabled:true のサイト: type ごとの必須キーが揃っている', () => {
  for (const entry of enabledSites) {
    const s = entry.site;
    const required = REQUIRED_BY_TYPE[s.type] || [];
    for (const key of required) {
      assert.ok(
        typeof s[key] === 'string' && s[key].trim() !== '',
        `${where(entry)} は type:${s.type} なので ${key} が必須（空だと必ず0件になる）`
      );
    }
  }
});

test('enabled:true の html サイト: 相対URLを絶対化するための baseUrl がある', () => {
  for (const entry of enabledSites) {
    const s = entry.site;
    if (s.type !== 'html' && s.type !== 'html-grouped' && s.type !== 'json') continue;
    assert.ok(
      typeof s.baseUrl === 'string' && /^https?:\/\//.test(s.baseUrl),
      `${where(entry)} に baseUrl が無い（相対hrefが絶対URLにならず全件落ちる）`
    );
  }
});

test('全サイト: note が書かれている（実測の記録が無い設定を増やさない）', () => {
  for (const entry of ALL_SITES) {
    assert.ok(
      typeof entry.site.note === 'string' && entry.site.note.trim().length >= 10,
      `${where(entry)} に note が無い。何を実測してこの設定にしたのか残すこと`
    );
  }
});

test('enabled:false のサイト: note に無効化した理由が書いてある', () => {
  const disabled = ALL_SITES.filter((e) => e.site && e.site.enabled === false);
  for (const entry of disabled) {
    const note = String(entry.site.note || '');
    assert.match(
      note,
      /403|404|ブロック|拒否|無応答|取得できな|取れな|robots|JS|使えな|扱いなし|重複|廃止|終了|停止|APIキー|未取得|未設定/,
      `${where(entry)} は enabled:false なのに note に実測の理由が無い: ${note.slice(0, 60)}`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 3. expectEmpty には理由が要る                                        */
/* ------------------------------------------------------------------ */

test('expectEmpty: true / false 以外の値を入れない', () => {
  for (const entry of ALL_SITES) {
    if (!('expectEmpty' in entry.site)) continue;
    assert.equal(
      typeof entry.site.expectEmpty,
      'boolean',
      `${where(entry)} の expectEmpty は真偽値で書くこと`
    );
  }
});

test('expectEmpty が付いているサイトには、0件が正常な理由が note に書いてある', () => {
  const marked = ALL_SITES.filter((e) => e.site.expectEmpty === true);

  // このフラグは「取得0件 — サイト構造が変わった可能性」の警告を止める。
  // 止める以上、なぜ止めてよいのかが設定ファイルの中で読めなければならない。
  assert.ok(marked.length > 0, 'expectEmpty が1件も無い。実装と設定がずれていないか確認すること');

  for (const entry of marked) {
    const note = String(entry.site.note || '');
    assert.match(
      note,
      /expectEmpty/,
      `${where(entry)} は expectEmpty:true なのに note でそれに触れていない`
    );
    assert.match(
      note,
      /0件|ゼロ件|正常|異常ではな/,
      `${where(entry)} の note に「0件でも正常」である説明が無い`
    );
    assert.ok(
      note.length >= 80,
      `${where(entry)} の note が短すぎる。何を実測して0件が正常と判断したのか書くこと`
    );
  }
});

test('expectEmpty を付けるのは、本当に抽出0件になりうるサイトだけ', () => {
  // 日付キーを持つサイト（楽天ブックスのAPI等）は、7日窓の外に落ちても
  // src/sources/shops.js が warn を出さない実装になっている。
  // そこに expectEmpty を足すと「抽出そのものが0＝故障」まで黙るので付けない。
  for (const entry of ALL_SITES) {
    if (entry.site.expectEmpty !== true) continue;
    if (entry.file !== 'config/shop-sources.json') continue;
    if (!entry.site.dateKey) continue;
    const note = String(entry.site.note || '');
    assert.match(
      note,
      /hit_count|stockExclude|在庫|全件/,
      `${where(entry)} は dateKey を持つので日付落ちでは警告が出ない。` +
        'それでも expectEmpty を付けるなら、日付以外の理由（在庫フィルタで全滅する等）と' +
        '本当の故障をどう見分けるかを note に書くこと'
    );
  }
});

/* ------------------------------------------------------------------ */
/* 4. id が一意であること                                               */
/* ------------------------------------------------------------------ */

test('id: config 内で重複していない', () => {
  const seen = new Map();
  for (const entry of ALL_SITES) {
    const id = entry.site.id;
    assert.ok(typeof id === 'string' && id.trim() !== '', `${where(entry)} に id が無い`);
    const prev = seen.get(id);
    assert.equal(prev, undefined, `id "${id}" が重複している: ${prev} と ${where(entry)}`);
    seen.set(id, where(entry));
  }
});

test('id: 情報源ID全体（feeds / googleNews を含む）で重複していない', () => {
  // sourceId は feed.json やレポートで情報源を指す鍵になる。
  // ニュースフィードと店のIDがぶつかると、集計がどちらか片方に寄って消える。
  const seen = new Map();
  const add = (id, place) => {
    assert.ok(typeof id === 'string' && id.trim() !== '', `${place} に id が無い`);
    const prev = seen.get(id);
    assert.equal(prev, undefined, `情報源ID "${id}" が重複している: ${prev} と ${place}`);
    seen.set(id, place);
  };
  for (const entry of ALL_SITES) add(entry.site.id, where(entry));
  (sources.feeds || []).forEach((f, i) => add(f.id, `config/sources.json feeds[${i}]`));
  ((sources.googleNews && sources.googleNews.queries) || []).forEach((q, i) =>
    add(q.id, `config/sources.json googleNews.queries[${i}]`)
  );
});

test('id: 小文字英数字とハイフンだけで書かれている', () => {
  for (const entry of ALL_SITES) {
    assert.match(
      entry.site.id,
      /^[a-z0-9][a-z0-9-]*$/,
      `${where(entry)} の id は小文字英数字とハイフンで書くこと`
    );
  }
});

/* ------------------------------------------------------------------ */
/* config/sources.json（キーワードとGoogleニュースクエリ）              */
/* ------------------------------------------------------------------ */

test('sources.json: feeds / googleNews のURLとクエリが空でない', () => {
  for (const [i, f] of (sources.feeds || []).entries()) {
    assert.match(
      String(f.url || ''),
      /^https?:\/\//,
      `config/sources.json feeds[${i}] (${f.id}) の url が不正: ${f.url}`
    );
  }
  const gn = sources.googleNews || {};
  assert.match(
    String(gn.urlTemplate || ''),
    /\{query\}/,
    'config/sources.json googleNews.urlTemplate に {query} の差し込みが無い'
  );
  for (const [i, q] of (gn.queries || []).entries()) {
    assert.ok(
      typeof q.query === 'string' && q.query.trim() !== '',
      `config/sources.json googleNews.queries[${i}] (${q.id}) の query が空`
    );
    assert.ok(
      Array.isArray(q.ips) && q.ips.length > 0,
      `config/sources.json googleNews.queries[${i}] (${q.id}) に ips が無い`
    );
  }
});

test('sources.json: ips のキーワードが全サイトの ips と食い違っていない', () => {
  const known = new Set(Object.keys(sources.ips || {}));
  assert.ok(known.size > 0, 'config/sources.json に ips 定義が無い');
  for (const entry of ALL_SITES) {
    for (const ip of entry.site.ips || []) {
      assert.ok(
        known.has(ip),
        `${where(entry)} が未知のIPキー "${ip}" を使っている（config/sources.json の ips に無い）`
      );
    }
  }
  for (const [i, q] of ((sources.googleNews && sources.googleNews.queries) || []).entries()) {
    for (const ip of q.ips || []) {
      assert.ok(
        known.has(ip),
        `config/sources.json googleNews.queries[${i}] (${q.id}) が未知のIPキー "${ip}" を使っている`
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* bot対策を回避しないという約束が設定側で守られていること               */
/* ------------------------------------------------------------------ */

test('defaults: User-Agent が TCGNewsBot のまま（ブラウザ偽装をしていない）', () => {
  for (const [name, cfg] of [
    ['config/official-sites.json', official],
    ['config/shop-sources.json', shops],
  ]) {
    const ua = String((cfg.defaults || {}).userAgent || '');
    assert.equal(
      ua,
      'Mozilla/5.0 (compatible; TCGNewsBot/1.0)',
      `${name} の defaults.userAgent が固定値から変わっている: ${ua}`
    );
  }
});
