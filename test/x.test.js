// test/x.test.js
// Node標準テストランナー / ネットワークアクセスなし（fetch はすべてスタブ注入）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  percentEncode,
  hmacSha1,
  buildSignatureBaseString,
  signBaseString,
  buildOAuthHeader,
  validateCreds,
  tweetUrl,
  verifyCredentials,
  postThread,
  postSingle,
} from '../src/x.js';

const CREDS = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  accessToken: 'test-access-token',
  accessTokenSecret: 'test-access-token-secret',
};

/** base64 -> hex（RFC2202 のテストベクタ比較用） */
const toHex = (b64) => Buffer.from(b64, 'base64').toString('hex');

/** fetch スタブ生成: 応答を順番に返し、呼び出しを記録する */
function makeFetchStub(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: next.statusText ?? '',
      headers: next.headers ?? {},
      text: async () => next.body ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

/** sleep スタブ: 実際には待たず、待機ミリ秒だけ記録する */
function makeSleepStub() {
  const waits = [];
  const fn = async (ms) => {
    waits.push(ms);
  };
  fn.waits = waits;
  return fn;
}

const noopLog = () => {};

// ---------------------------------------------------------------------------
// percentEncode (RFC3986)
// ---------------------------------------------------------------------------

test('percentEncode: 非予約文字 -_.~ はエンコードしない', () => {
  assert.equal(percentEncode('abcXYZ019-._~'), 'abcXYZ019-._~');
});

test('percentEncode: encodeURIComponent が見逃す !*\'() もエンコードする', () => {
  assert.equal(percentEncode('!'), '%21');
  assert.equal(percentEncode('*'), '%2A');
  assert.equal(percentEncode("'"), '%27');
  assert.equal(percentEncode('('), '%28');
  assert.equal(percentEncode(')'), '%29');
});

test('percentEncode: 予約文字・空白・マルチバイト', () => {
  assert.equal(percentEncode(' '), '%20');
  assert.equal(percentEncode('+'), '%2B');
  assert.equal(percentEncode('&'), '%26');
  assert.equal(percentEncode('='), '%3D');
  assert.equal(percentEncode('%'), '%25');
  assert.equal(percentEncode('/'), '%2F');
  assert.equal(percentEncode('あ'), '%E3%81%82');
  assert.equal(percentEncode('Ladies + Add Me'), 'Ladies%20%2B%20Add%20Me');
  assert.equal(percentEncode(undefined), '');
  assert.equal(percentEncode(null), '');
});

// ---------------------------------------------------------------------------
// HMAC-SHA1 (RFC 2202 公式テストベクタ)
// ---------------------------------------------------------------------------

test('hmacSha1: RFC2202 テストケース1', () => {
  // key = 0x0b * 20, data = "Hi There"
  assert.equal(
    toHex(hmacSha1(Buffer.alloc(20, 0x0b), 'Hi There')),
    'b617318655057264e28bc0b6fb378c8ef146be00',
  );
});

test('hmacSha1: RFC2202 テストケース2', () => {
  // key = "Jefe", data = "what do ya want for nothing?"
  assert.equal(
    toHex(hmacSha1('Jefe', 'what do ya want for nothing?')),
    'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
  );
});

// ---------------------------------------------------------------------------
// 署名ベース文字列 (RFC 5849 §3.4.1.1 の公式サンプル)
// ---------------------------------------------------------------------------

test('buildSignatureBaseString: RFC 5849 §3.4.1.1 の公式サンプルと一致する', () => {
  const url = 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b';
  const params = [
    // POSTボディ由来のパラメータ（RFCサンプル: c2&a3=2+q）
    ['c2', ''],
    ['a3', '2 q'],
    // oauth パラメータ
    ['oauth_consumer_key', '9djdj82h48djs9d2'],
    ['oauth_token', 'kkk9d7dh3k39sjv7'],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', '137131201'],
    ['oauth_nonce', '7d8f3e4a'],
  ];

  const expected =
    'POST&http%3A%2F%2Fexample.com%2Frequest&' +
    'a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26' +
    'oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26' +
    'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26' +
    'oauth_token%3Dkkk9d7dh3k39sjv7';

  assert.equal(buildSignatureBaseString('POST', url, params), expected);
});

test('buildSignatureBaseString: URLのクエリ文字列も署名対象に含める', () => {
  const base = buildSignatureBaseString('GET', 'https://api.x.com/2/users/me?expansions=pinned_tweet_id', {
    oauth_nonce: 'abc',
  });
  // ベースURLからクエリは除去される
  assert.ok(base.startsWith('GET&https%3A%2F%2Fapi.x.com%2F2%2Fusers%2Fme&'));
  assert.ok(base.includes('expansions%3Dpinned_tweet_id'));
  assert.ok(base.includes('oauth_nonce%3Dabc'));
});

test('buildSignatureBaseString: メソッドは大文字化、ホストは小文字化される', () => {
  const base = buildSignatureBaseString('post', 'https://API.X.COM/2/tweets', {});
  assert.equal(base, 'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&');
});

// ---------------------------------------------------------------------------
// 署名キー
// ---------------------------------------------------------------------------

test('signBaseString: 署名キーは pctEnc(consumerSecret)&pctEnc(tokenSecret)', () => {
  const base = 'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&';
  // 特殊文字を含むシークレットが正しくエンコードされてキーになること
  assert.equal(signBaseString(base, 'a+b', 'c d'), hmacSha1('a%2Bb&c%20d', base));
  // token secret 省略時は末尾が「&」だけになる
  assert.equal(signBaseString(base, 'Jefe'), hmacSha1('Jefe&', base));
});

test('signBaseString: 同じ入力なら決定的（再現性がある）', () => {
  const base = buildSignatureBaseString('POST', 'https://api.x.com/2/tweets', {
    oauth_consumer_key: 'ck',
    oauth_nonce: 'n',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1700000000',
    oauth_token: 'tk',
    oauth_version: '1.0',
  });
  const a = signBaseString(base, 'cs', 'ts');
  const b = signBaseString(base, 'cs', 'ts');
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9+/]+=*$/); // base64
  assert.equal(Buffer.from(a, 'base64').length, 20); // SHA-1 は20バイト
});

// ---------------------------------------------------------------------------
// Authorization ヘッダ
// ---------------------------------------------------------------------------

test('buildOAuthHeader: OAuth 1.0a の必須パラメータをすべて含む', () => {
  const header = buildOAuthHeader('POST', 'https://api.x.com/2/tweets', CREDS, {
    nonce: 'a'.repeat(32),
    timestamp: 1700000000,
  });
  assert.ok(header.startsWith('OAuth '));
  for (const key of [
    'oauth_consumer_key',
    'oauth_nonce',
    'oauth_signature',
    'oauth_signature_method',
    'oauth_timestamp',
    'oauth_token',
    'oauth_version',
  ]) {
    assert.ok(header.includes(`${key}="`), `${key} が無い: ${header}`);
  }
  assert.ok(header.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.ok(header.includes('oauth_version="1.0"'));
  assert.ok(header.includes('oauth_timestamp="1700000000"'));
  // カンマ+スペース区切り
  assert.ok(header.includes('", '));
});

test('buildOAuthHeader: 署名は自前で再計算した値と一致する', () => {
  const url = 'https://api.x.com/2/tweets';
  const nonce = 'b'.repeat(32);
  const timestamp = 1700000000;
  const header = buildOAuthHeader('POST', url, CREDS, { nonce, timestamp });

  const base = buildSignatureBaseString('POST', url, {
    oauth_consumer_key: CREDS.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: CREDS.accessToken,
    oauth_version: '1.0',
  });
  const expected = signBaseString(base, CREDS.apiSecret, CREDS.accessTokenSecret);

  assert.ok(
    header.includes(`oauth_signature="${percentEncode(expected)}"`),
    `期待した署名が入っていない\nheader: ${header}\nexpected: ${expected}`,
  );
});

test('buildOAuthHeader: nonce は32桁hexで毎回変わる', () => {
  const url = 'https://api.x.com/2/tweets';
  const grab = () => buildOAuthHeader('POST', url, CREDS).match(/oauth_nonce="([^"]+)"/)[1];
  const a = grab();
  const b = grab();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('buildOAuthHeader: ヘッダには extraParams を載せない（署名にのみ使う）', () => {
  const url = 'https://api.x.com/2/tweets';
  const header = buildOAuthHeader('POST', url, CREDS, {
    extraParams: { secret_field: 'should-not-appear' },
    nonce: 'c'.repeat(32),
    timestamp: 1700000000,
  });
  assert.equal(header.includes('secret_field'), false);
  assert.equal(header.includes('should-not-appear'), false);
});

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

test('validateCreds: 不足しているキーを日本語で指摘する', () => {
  assert.equal(validateCreds(CREDS), null);
  const err = validateCreds({ ...CREDS, accessToken: '' });
  assert.ok(err && err.includes('X_ACCESS_TOKEN'));
  assert.ok(validateCreds({}).includes('X_API_KEY'));
  assert.ok(validateCreds(null).includes('X_API_KEY'));
});

test('tweetUrl: username が分かれば /{username}/status/{id}', () => {
  assert.equal(tweetUrl('123'), 'https://x.com/i/web/status/123');
  assert.equal(tweetUrl('123', 'tcgbot'), 'https://x.com/tcgbot/status/123');
});

// ---------------------------------------------------------------------------
// postThread / dryRun
// ---------------------------------------------------------------------------

test('postThread(dryRun): APIを一切叩かず dry-N のIDを返す', async () => {
  const fetchImpl = () => {
    throw new Error('dryRun なのに fetch が呼ばれた');
  };
  const logs = [];
  const result = await postThread(['1本目', '2本目', '3本目'], CREDS, {
    dryRun: true,
    fetchImpl,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result.ids, ['dry-1', 'dry-2', 'dry-3']);
  assert.deepEqual(result.urls, []);
  assert.ok(logs.join('\n').includes('DRY RUN'));
  assert.ok(logs.join('\n').includes('2本目'));
});

test('postThread(dryRun): 認証情報が空でも動く（プレビュー用途）', async () => {
  const result = await postThread(['プレビュー'], {}, { dryRun: true, log: noopLog });
  assert.deepEqual(result.ids, ['dry-1']);
});

test('postThread(dryRun): {text} オブジェクト配列も受け付ける', async () => {
  const result = await postThread([{ text: 'あ' }, { text: 'い' }], CREDS, {
    dryRun: true,
    log: noopLog,
  });
  assert.deepEqual(result.ids, ['dry-1', 'dry-2']);
});

test('postThread: 空配列は何もしない', async () => {
  const result = await postThread([], CREDS, { dryRun: true, log: noopLog });
  assert.deepEqual(result, { ids: [], urls: [] });
});

// ---------------------------------------------------------------------------
// postThread / 本番系（fetch スタブ）
// ---------------------------------------------------------------------------

test('postThread: 2本目以降は in_reply_to_tweet_id で連結され、間に3秒待つ', async () => {
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    n += 1;
    calls.push({ url, init });
    return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ data: { id: `10${n}` } }) };
  };
  const sleepImpl = makeSleepStub();

  const result = await postThread(['a', 'b', 'c'], CREDS, {
    fetchImpl,
    sleepImpl,
    username: 'tcgbot',
    log: noopLog,
  });

  assert.deepEqual(result.ids, ['101', '102', '103']);
  assert.deepEqual(result.urls, [
    'https://x.com/tcgbot/status/101',
    'https://x.com/tcgbot/status/102',
    'https://x.com/tcgbot/status/103',
  ]);

  // 1本目はreplyなし
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'a' });
  // 2本目/3本目は直前のIDへのリプライ
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'b', reply: { in_reply_to_tweet_id: '101' } });
  assert.deepEqual(JSON.parse(calls[2].init.body), { text: 'c', reply: { in_reply_to_tweet_id: '102' } });

  // ツイート間に3秒 x 2回
  assert.deepEqual(sleepImpl.waits, [3000, 3000]);

  // OAuth ヘッダと Content-Type
  assert.ok(calls[0].init.headers.Authorization.startsWith('OAuth '));
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].url, 'https://api.x.com/2/tweets');
});

test('postThread: 503は指数バックオフでリトライして成功する', async () => {
  const fetchImpl = makeFetchStub([
    { status: 503, body: 'service unavailable' },
    { status: 503, body: 'service unavailable' },
    { status: 200, body: JSON.stringify({ data: { id: '999' } }) },
  ]);
  const sleepImpl = makeSleepStub();

  const result = await postThread(['x'], CREDS, { fetchImpl, sleepImpl, log: noopLog });
  assert.deepEqual(result.ids, ['999']);
  assert.deepEqual(sleepImpl.waits, [5000, 10000]); // 初回5秒 → 10秒
  assert.equal(fetchImpl.calls.length, 3);
});

test('postThread: 429 は x-rate-limit-reset を優先して待つ（上限120秒）', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 30;
  const fetchImpl = makeFetchStub([
    { status: 429, headers: { 'x-rate-limit-reset': String(resetAt) }, body: 'too many requests' },
    { status: 200, body: JSON.stringify({ data: { id: '77' } }) },
  ]);
  const sleepImpl = makeSleepStub();

  const result = await postThread(['x'], CREDS, { fetchImpl, sleepImpl, log: noopLog });
  assert.deepEqual(result.ids, ['77']);
  assert.equal(sleepImpl.waits.length, 1);
  // バックオフ既定(5秒)ではなくリセットまでの時間(約30秒)を使う
  assert.ok(sleepImpl.waits[0] > 25000 && sleepImpl.waits[0] <= 30000, `wait=${sleepImpl.waits[0]}`);
});

test('postThread: reset が遠すぎる場合は120秒で頭打ち', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 9999;
  const fetchImpl = makeFetchStub([
    { status: 429, headers: { 'x-rate-limit-reset': String(resetAt) }, body: '' },
    { status: 200, body: JSON.stringify({ data: { id: '1' } }) },
  ]);
  const sleepImpl = makeSleepStub();
  await postThread(['x'], CREDS, { fetchImpl, sleepImpl, log: noopLog });
  assert.equal(sleepImpl.waits[0], 120000);
});

test('postThread: リトライ上限（3回）を超えたら失敗する', async () => {
  const fetchImpl = makeFetchStub([{ status: 500, body: 'boom' }]);
  const sleepImpl = makeSleepStub();

  await assert.rejects(
    postThread(['x'], CREDS, { fetchImpl, sleepImpl, log: noopLog }),
    (err) => {
      assert.ok(err.message.includes('1本目の投稿に失敗'), err.message);
      assert.ok(err.message.includes('500'));
      assert.deepEqual(err.postedIds, []);
      return true;
    },
  );
  assert.deepEqual(sleepImpl.waits, [5000, 10000, 20000]);
  assert.equal(fetchImpl.calls.length, 4); // 初回 + リトライ3回
});

test('postThread: 401/403 は即座に失敗しリトライしない', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = makeFetchStub([{ status, body: 'nope' }]);
    const sleepImpl = makeSleepStub();
    await assert.rejects(
      postThread(['x'], CREDS, { fetchImpl, sleepImpl, log: noopLog }),
      (err) => {
        assert.ok(err.message.includes(String(status)), err.message);
        assert.ok(err.message.includes('ヒント'), ' 日本語ヒントが無い');
        return true;
      },
    );
    assert.equal(fetchImpl.calls.length, 1, `${status} でリトライしている`);
    assert.deepEqual(sleepImpl.waits, []);
  }
});

test('postThread: 途中で失敗したら err.postedIds に投稿済みIDが入る', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ data: { id: '501' } }) };
    return { ok: false, status: 403, statusText: 'Forbidden', headers: {}, text: async () => 'forbidden' };
  };
  const sleepImpl = makeSleepStub();

  await assert.rejects(
    postThread(['a', 'b', 'c'], CREDS, { fetchImpl, sleepImpl, log: noopLog }),
    (err) => {
      assert.ok(err.message.includes('2本目の投稿に失敗'), err.message);
      assert.deepEqual(err.postedIds, ['501']);
      return true;
    },
  );
});

test('postThread: 認証情報が無ければ（dryRunでなければ）throw', async () => {
  await assert.rejects(
    postThread(['x'], { apiKey: 'only-key' }, { fetchImpl: makeFetchStub([]), log: noopLog }),
    /認証情報が不足/,
  );
});

test('postSingle: postThread に委譲して id/url を返す', async () => {
  const fetchImpl = makeFetchStub([{ status: 200, body: JSON.stringify({ data: { id: '42' } }) }]);
  const result = await postSingle('単発', CREDS, {
    fetchImpl,
    sleepImpl: makeSleepStub(),
    username: 'tcgbot',
    log: noopLog,
  });
  assert.equal(result.id, '42');
  assert.equal(result.url, 'https://x.com/tcgbot/status/42');
  assert.deepEqual(result.ids, ['42']);
  assert.equal(fetchImpl.calls.length, 1);
});

test('postSingle(dryRun): APIを叩かない', async () => {
  const result = await postSingle('単発', CREDS, { dryRun: true, log: noopLog });
  assert.equal(result.id, 'dry-1');
  assert.equal(result.url, null);
});

// ---------------------------------------------------------------------------
// verifyCredentials
// ---------------------------------------------------------------------------

test('verifyCredentials: 成功時は username と id を返す', async () => {
  const fetchImpl = makeFetchStub([
    { status: 200, body: JSON.stringify({ data: { id: '1234567890', username: 'tcgbot', name: 'TCG Bot' } }) },
  ]);
  const result = await verifyCredentials(CREDS, { fetchImpl });
  assert.deepEqual(result, { ok: true, username: 'tcgbot', id: '1234567890' });
  assert.equal(fetchImpl.calls[0].url, 'https://api.x.com/2/users/me');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.ok(fetchImpl.calls[0].init.headers.Authorization.startsWith('OAuth '));
});

test('verifyCredentials: 401 は throw せずヒント付きで返す', async () => {
  const fetchImpl = makeFetchStub([{ status: 401, statusText: 'Unauthorized', body: '{"title":"Unauthorized"}' }]);
  const result = await verifyCredentials(CREDS, { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('401'), result.error);
  assert.ok(result.error.includes('Unauthorized'), result.error);
  assert.ok(result.error.includes('時刻ずれ'), result.error);
});

test('verifyCredentials: 403 は Read and write のヒントを添える', async () => {
  const fetchImpl = makeFetchStub([{ status: 403, body: 'forbidden' }]);
  const result = await verifyCredentials(CREDS, { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Read and write'), result.error);
  assert.ok(result.error.includes('Access Token を再生成'), result.error);
});

test('verifyCredentials: 通信エラーでも throw しない', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.x.com');
  };
  const result = await verifyCredentials(CREDS, { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('通信エラー'), result.error);
});

test('verifyCredentials: 認証情報が空なら通信せずエラーを返す', async () => {
  const fetchImpl = () => {
    throw new Error('fetch されてはいけない');
  };
  const result = await verifyCredentials({}, { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('X_API_KEY'), result.error);
});

test('verifyCredentials: JSONでない応答でも throw しない', async () => {
  const fetchImpl = makeFetchStub([{ status: 200, body: '<html>maintenance</html>' }]);
  const result = await verifyCredentials(CREDS, { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('JSON'), result.error);
});
