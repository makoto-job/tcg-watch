/**
 * test/rss.test.js — ネットワークアクセスなしで動くユニットテスト
 * 実行: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFeed,
  decodeEntities,
  stripCdata,
  stripTags,
  cleanText,
  getAttr,
  toIso,
} from '../src/rss.js';

import {
  canonicalizeUrl,
  decodeGoogleNewsUrl,
  resolveUrl,
  isGoogleNewsUrl,
  extractRealUrlFromHtml,
  resolveViaBatchExecute,
  clearResolveCache,
} from '../src/resolve.js';

/* ------------------------------------------------------------------ */
/* サンプルXML                                                         */
/* ------------------------------------------------------------------ */

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>4Gamer.net</title>
    <link>https://www.4gamer.net/</link>
    <description>ゲーム総合情報サイト</description>
    <item>
      <title><![CDATA[ポケモンカード「ハイクラスパック」抽選販売が開始]]></title>
      <link>https://www.4gamer.net/games/999/G999999/20260823001/?utm_source=rss&amp;utm_medium=feed</link>
      <guid isPermaLink="false">tag:4gamer,2026:1</guid>
      <pubDate>Sat, 22 Aug 2026 09:30:00 +0900</pubDate>
      <description><![CDATA[<p>ポケモン&amp;カードの<b>抽選</b>受付が始まった&#12290;</p>]]></description>
    </item>
    <item>
      <title>ワンピースカード 新弾&quot;頂上決戦&quot;の予約受付</title>
      <link>https://example.jp/news/1</link>
      <pubDate>2026-08-21T12:00:00+09:00</pubDate>
      <description>ONE PIECE&#39;s new set</description>
      <source url="https://example.jp">サンプルニュース</source>
    </item>
  </channel>
</rss>`;

const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://www.famitsu.com/">
    <title>ファミ通.com</title>
    <link>https://www.famitsu.com/</link>
    <description>ゲーム情報</description>
    <items>
      <rdf:Seq>
        <rdf:li rdf:resource="https://www.famitsu.com/news/1.html" />
      </rdf:Seq>
    </items>
  </channel>
  <item rdf:about="https://www.famitsu.com/news/1.html">
    <title>遊戯王OCG 新商品の予約が開始&#x3002;</title>
    <link>https://www.famitsu.com/news/1.html</link>
    <description>ラッシュデュエル関連の&lt;strong&gt;再販&lt;/strong&gt;情報</description>
    <dc:date>2026-08-20T10:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>電撃オンライン</title>
  <link rel="self" href="https://dengekionline.com/rss/index.xml"/>
  <updated>2026-08-23T00:00:00Z</updated>
  <entry>
    <title type="html">フュージョンワールド 第10弾&amp;プロモが登場</title>
    <link rel="alternate" type="text/html" href="https://dengekionline.com/articles/123/"/>
    <link rel="edit" href="https://dengekionline.com/edit/123"/>
    <id>tag:dengeki,2026:123</id>
    <published>2026-08-22T18:00:00+09:00</published>
    <updated>2026-08-22T19:00:00+09:00</updated>
    <summary type="html">&lt;p&gt;ドラゴンボールカードの受注生産が決定&lt;/p&gt;</summary>
    <author><name>電撃編集部</name></author>
  </entry>
  <entry>
    <title><![CDATA[ガンダムカードゲーム 発売日決定]]></title>
    <link href="https://dengekionline.com/articles/124/"/>
    <id>https://dengekionline.com/articles/124/</id>
    <updated>2026-08-23T01:00:00Z</updated>
    <content type="html">GUNDAM CARD GAME の情報</content>
  </entry>
</feed>`;

/* ------------------------------------------------------------------ */
/* 低レベルユーティリティ                                              */
/* ------------------------------------------------------------------ */

test('decodeEntities: 名前付き・10進・16進の各参照を復号する', () => {
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
  assert.equal(decodeEntities('&quot;x&quot;'), '"x"');
  assert.equal(decodeEntities('it&#39;s'), "it's");
  assert.equal(decodeEntities('it&#x27;s'), "it's");
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('&#12509;&#12465;&#12459;'), 'ポケカ');
  assert.equal(decodeEntities('&#x30DD;'), 'ポ');
  // 未知のエンティティはそのまま
  assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
  // 1パスなので二重復号しない
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('stripCdata / stripTags / cleanText', () => {
  assert.equal(stripCdata('<![CDATA[あ]]>い<![CDATA[う]]>'), 'あいう');
  assert.equal(stripTags('<p>あ<b>い</b></p>'), 'あい ');
  assert.equal(cleanText('<![CDATA[<p>ポケモン&amp;カード</p>]]>'), 'ポケモン&カード');
  assert.equal(cleanText('  複数   空白\n改行 '), '複数 空白 改行');
});

test('getAttr: シングル/ダブル/無クォート属性', () => {
  assert.equal(getAttr(' href="https://a.example/" rel="alternate"', 'href'), 'https://a.example/');
  assert.equal(getAttr(" href='https://b.example/'", 'href'), 'https://b.example/');
  assert.equal(getAttr(' url=https://c.example/', 'url'), 'https://c.example/');
  assert.equal(getAttr(' href="https://d.example/?a=1&amp;b=2"', 'href'), 'https://d.example/?a=1&b=2');
  assert.equal(getAttr('', 'href'), '');
});

test('toIso: RFC822 / ISO をパース、不正値は空文字', () => {
  assert.equal(toIso('Sat, 22 Aug 2026 09:30:00 +0900'), '2026-08-22T00:30:00.000Z');
  assert.equal(toIso('2026-08-21T12:00:00+09:00'), '2026-08-21T03:00:00.000Z');
  assert.equal(toIso('not a date at all'), '');
  assert.equal(toIso(''), '');
});

/* ------------------------------------------------------------------ */
/* parseFeed                                                           */
/* ------------------------------------------------------------------ */

test('parseFeed: RSS 2.0 をパースする（CDATA・エンティティ・日本語）', () => {
  const feed = parseFeed(RSS2);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, '4Gamer.net');
  assert.equal(feed.items.length, 2);

  const a = feed.items[0];
  assert.equal(a.title, 'ポケモンカード「ハイクラスパック」抽選販売が開始');
  assert.equal(a.link, 'https://www.4gamer.net/games/999/G999999/20260823001/?utm_source=rss&utm_medium=feed');
  assert.equal(a.guid, 'tag:4gamer,2026:1');
  assert.equal(a.pubDate, '2026-08-22T00:30:00.000Z');
  assert.equal(a.description, 'ポケモン&カードの抽選受付が始まった。');
  assert.equal(a.sourceName, '');

  const b = feed.items[1];
  assert.equal(b.title, 'ワンピースカード 新弾"頂上決戦"の予約受付');
  assert.equal(b.description, "ONE PIECE's new set");
  assert.equal(b.sourceName, 'サンプルニュース');
});

test('parseFeed: RDF(RSS 1.0) をパースし dc:date を拾う', () => {
  const feed = parseFeed(RDF);
  assert.equal(feed.format, 'rdf');
  assert.equal(feed.title, 'ファミ通.com');
  assert.equal(feed.items.length, 1, '<items><rdf:Seq> を item と誤認しないこと');

  const it = feed.items[0];
  assert.equal(it.title, '遊戯王OCG 新商品の予約が開始。');
  assert.equal(it.link, 'https://www.famitsu.com/news/1.html');
  assert.equal(it.pubDate, '2026-08-20T01:00:00.000Z');
  assert.equal(it.description, 'ラッシュデュエル関連の再販情報');
});

test('parseFeed: Atom をパースし rel="alternate" の href を優先する', () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, '電撃オンライン');
  assert.equal(feed.items.length, 2);

  const a = feed.items[0];
  assert.equal(a.title, 'フュージョンワールド 第10弾&プロモが登場');
  assert.equal(a.link, 'https://dengekionline.com/articles/123/');
  // published を updated より優先
  assert.equal(a.pubDate, '2026-08-22T09:00:00.000Z');
  assert.equal(a.description, 'ドラゴンボールカードの受注生産が決定');
  assert.equal(a.sourceName, '電撃編集部');

  const b = feed.items[1];
  assert.equal(b.title, 'ガンダムカードゲーム 発売日決定');
  assert.equal(b.link, 'https://dengekionline.com/articles/124/');
  assert.equal(b.pubDate, '2026-08-23T01:00:00.000Z');
  assert.equal(b.description, 'GUNDAM CARD GAME の情報');
});

test('parseFeed: 空文字・壊れた入力でも throw しない', () => {
  assert.deepEqual(parseFeed('').items, []);
  assert.deepEqual(parseFeed(null).items, []);
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>').items, []);
});

test('parseFeed: Google News 形式の <source url> から sourceName を得る', () => {
  const xml = `<rss version="2.0"><channel><title>"ポケモンカード 抽選" - Google ニュース</title>
    <item>
      <title>ポケカ抽選販売、8月23日から - 4Gamer.net</title>
      <link>https://news.google.com/rss/articles/ABCDEF?oc=5</link>
      <pubDate>Fri, 22 Aug 2026 03:00:00 GMT</pubDate>
      <source url="https://www.4gamer.net">4Gamer.net</source>
    </item></channel></rss>`;
  const feed = parseFeed(xml);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceName, '4Gamer.net');
  assert.equal(feed.items[0].link, 'https://news.google.com/rss/articles/ABCDEF?oc=5');
});

/* ------------------------------------------------------------------ */
/* canonicalizeUrl                                                     */
/* ------------------------------------------------------------------ */

test('canonicalizeUrl: トラッキングパラメータを除去する', () => {
  assert.equal(
    canonicalizeUrl('https://Example.COM/news/1?utm_source=rss&utm_medium=feed&id=5'),
    'https://example.com/news/1?id=5'
  );
  assert.equal(canonicalizeUrl('https://example.com/a?gclid=xxx'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('https://example.com/a?fbclid=x&yclid=y&ref=z'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('https://example.com/a?ref_src=twsrc&spm=1&cmpid=2&_ga=3'), 'https://example.com/a');
});

test('canonicalizeUrl: ハッシュ除去・ホスト小文字化・末尾スラッシュ正規化', () => {
  assert.equal(canonicalizeUrl('https://example.com/a/#section'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('https://EXAMPLE.com/'), 'https://example.com/', 'パスが / だけなら残す');
  assert.equal(canonicalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(canonicalizeUrl('https://example.com/a/b///'), 'https://example.com/a/b');
});

test('canonicalizeUrl: パースできない入力はそのまま返す', () => {
  assert.equal(canonicalizeUrl('これはURLではない'), 'これはURLではない');
  assert.equal(canonicalizeUrl(''), '');
  assert.equal(canonicalizeUrl('mailto:a@example.com'), 'mailto:a@example.com');
});

/* ------------------------------------------------------------------ */
/* Google ニュース解決（オフライン）                                   */
/* ------------------------------------------------------------------ */

/** 旧形式のGoogleニュースIDを模したペイロードを作る */
function makeGoogleNewsId(realUrl) {
  const urlBytes = Buffer.from(realUrl, 'utf8');
  const payload = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22]), // 先頭のゴミ（プレフィックス）
    Buffer.from([urlBytes.length]), // 長さプレフィックス
    urlBytes,
    Buffer.from([0x00, 0xd2, 0x01, 0x00]), // 末尾のゴミ
  ]);
  return payload.toString('base64url');
}

test('decodeGoogleNewsUrl: 埋め込まれた実URLをオフラインで取り出す', () => {
  const real = 'https://www.4gamer.net/games/123/G012345/20260822001/';
  const id = makeGoogleNewsId(real);
  const decoded = decodeGoogleNewsUrl(`https://news.google.com/rss/articles/${id}?oc=5&hl=ja`);
  assert.equal(decoded, real);
});

test('decodeGoogleNewsUrl: URLを含まないIDでは null', () => {
  const id = Buffer.from([0x08, 0x13, 0x22, 0x04, 0x01, 0x02, 0x03, 0x04]).toString('base64url');
  assert.equal(decodeGoogleNewsUrl(`https://news.google.com/rss/articles/${id}`), null);
  assert.equal(decodeGoogleNewsUrl('https://example.com/a'), null);
});

test('isGoogleNewsUrl', () => {
  assert.equal(isGoogleNewsUrl('https://news.google.com/rss/articles/X'), true);
  assert.equal(isGoogleNewsUrl('https://www.4gamer.net/'), false);
  assert.equal(isGoogleNewsUrl('not a url'), false);
});

test('resolveUrl: オフラインデコードで解決し、正規化して返す（ネットワーク不使用）', async () => {
  clearResolveCache();
  const real = 'https://hobby.watch.impress.co.jp/docs/news/1234567.html?utm_source=googlenews';
  const id = makeGoogleNewsId(real);
  const got = await resolveUrl(`https://news.google.com/rss/articles/${id}?oc=5`);
  assert.equal(got, 'https://hobby.watch.impress.co.jp/docs/news/1234567.html');
});

test('resolveUrl: Googleニュース以外は正規化のみで即返す', async () => {
  clearResolveCache();
  assert.equal(
    await resolveUrl('https://www.famitsu.com/news/1.html?utm_campaign=x#top'),
    'https://www.famitsu.com/news/1.html'
  );
  assert.equal(await resolveUrl('これはURLではない'), 'これはURLではない');
  assert.equal(await resolveUrl(''), '');
});

test('resolveUrl: メモ化されている（2回目はネットワークに出ない）', async () => {
  clearResolveCache();
  const real = 'https://www.famitsu.com/news/9.html';
  const id = makeGoogleNewsId(real);
  const input = `https://news.google.com/rss/articles/${id}`;
  const first = await resolveUrl(input);

  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('キャッシュが効いていればここは呼ばれない');
  };
  try {
    const second = await resolveUrl(input);
    assert.equal(second, first);
  } finally {
    globalThis.fetch = orig;
  }
});

test('extractRealUrlFromHtml: data-n-au / meta refresh / c-wiz の順で拾う', () => {
  assert.equal(
    extractRealUrlFromHtml('<a data-n-au="https://a.example/x?a=1&amp;b=2">'),
    'https://a.example/x?a=1&b=2'
  );
  assert.equal(
    extractRealUrlFromHtml('<meta http-equiv="refresh" content="0; URL=https://b.example/y">'),
    'https://b.example/y'
  );
  assert.equal(
    extractRealUrlFromHtml('<c-wiz jsrenderer="x"><a href="https://c.example/z">go</a></c-wiz>'),
    'https://c.example/z'
  );
  assert.equal(extractRealUrlFromHtml('<html></html>'), null);
});

/* ------------------------------------------------------------------ */
/* batchexecute 経由の解決（fetch をスタブ）                           */
/* ------------------------------------------------------------------ */

const SPLASH_HTML =
  '<c-wiz jsrenderer="lW1Lhc" data-n-a-sg="Ae5Wzi8SIGNATURE" data-n-a-ts="1787470856" data-n-a-id="CBMifTESTID"></c-wiz>';

test('resolveViaBatchExecute: 署名付きパラメータが無ければ null（fetchしない）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('署名が無いのにfetchしてはいけない');
  };
  try {
    assert.equal(await resolveViaBatchExecute('<html></html>'), null);
    assert.equal(await resolveViaBatchExecute(''), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveViaBatchExecute: garturlres から実URLを取り出す', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return {
      ok: true,
      status: 200,
      text: async () =>
        `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://news.yahoo.co.jp/articles/abc123\\",1]",null,null,null,"generic"]]`,
    };
  };
  try {
    const got = await resolveViaBatchExecute(SPLASH_HTML);
    assert.equal(got, 'https://news.yahoo.co.jp/articles/abc123');
    assert.equal(seen.url, 'https://news.google.com/_/DotsSplashUi/data/batchexecute');
    assert.equal(seen.init.method, 'POST');
    assert.ok(seen.init.body.startsWith('f.req='));
    const req = JSON.parse(decodeURIComponent(seen.init.body.slice('f.req='.length)));
    assert.equal(req[0][0][0], 'Fbv4je');
    const inner = JSON.parse(req[0][0][1]);
    assert.equal(inner[0], 'garturlreq');
    assert.equal(inner[2], 'CBMifTESTID');
    assert.equal(inner[3], 1787470856);
    assert.equal(inner[4], 'Ae5Wzi8SIGNATURE');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveViaBatchExecute: エラー・不正応答でも null（throw しない）', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
    assert.equal(await resolveViaBatchExecute(SPLASH_HTML), null);

    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => ')]}\'\n\n[["wrb.fr"]]' });
    assert.equal(await resolveViaBatchExecute(SPLASH_HTML), null);

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    assert.equal(await resolveViaBatchExecute(SPLASH_HTML), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveUrl: オフラインデコード失敗時は中間ページ→batchexecute の順にフォールバックする', async () => {
  clearResolveCache();
  const input = 'https://news.google.com/rss/articles/CBMiOPAQUEID?oc=5';
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url) === input) {
      return { ok: true, status: 200, url: input, text: async () => SPLASH_HTML };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.4gamer.net/games/1/G1/2026/?utm_source=gnews\\",1]"]]`,
    };
  };
  try {
    const got = await resolveUrl(input);
    assert.equal(got, 'https://www.4gamer.net/games/1/G1/2026', 'utm_* 除去・末尾スラッシュ正規化まで通ること');
    assert.equal(calls.length, 2, '中間ページ取得 + batchexecute の2回');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveUrl: すべて失敗したら入力をそのまま返す（throw しない）', async () => {
  clearResolveCache();
  const input = 'https://news.google.com/rss/articles/CBMiOPAQUEID2?oc=5';
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    assert.equal(await resolveUrl(input), canonicalizeUrl(input));
  } finally {
    globalThis.fetch = orig;
  }
});
