/**
 * Service Worker のキャッシュ方針をNode上で検証する。
 *
 * 作った理由:
 *   feed.json の扱いを stale-while-revalidate（キャッシュ優先）から
 *   network-first（通信優先）に変えた。
 *   これは「開いた直後に見えるのが前回のデータ」という事故を防ぐための変更で、
 *   このアプリの存在意義に直結する。ブラウザ上で毎回手で確かめるのは無理なので、
 *   sw.js を偽の self / caches / fetch の上で実行して動きを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 最小限の Response 代用品 */
class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status === undefined ? 200 : init.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers || {};
  }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: this.headers }); }
  async json() { return JSON.parse(this.body); }
  async text() { return String(this.body); }
}

/** cache.put / match だけ持つ偽キャッシュ */
function makeCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async put(req, res) { m.set(typeof req === 'string' ? req : req.url, res); },
        async match(req) { return m.get(typeof req === 'string' ? req : req.url) || undefined; },
        async add() {},
        async delete() { return true; },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}

/**
 * sw.js を隔離した文脈で読み込み、中の関数を取り出す。
 * addEventListener は握りつぶす（登録されるだけで実行はしない）。
 */
async function loadSw({ fetchImpl }) {
  const src = await readFile(join(ROOT, 'app/sw.js'), 'utf8');
  const listeners = new Map();
  const self = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    registration: { scope: 'https://example.test/app/' },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const sandbox = {
    self,
    caches: makeCaches(),
    fetch: fetchImpl,
    Response: FakeResponse,
    URL,
    Request: class { constructor(u) { this.url = String(u); } },
    setTimeout,
    clearTimeout,
    console: { warn() {}, log() {} },
    Promise,
    JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 末尾で内部関数を取り出せるようにする
  vm.runInContext(`${src}\n;globalThis.__exports = { feedNetworkFirst, isFeedRequest, cacheFirst, networkFirst };`, sandbox);
  return { ...sandbox.__exports, sandbox, listeners };
}

test('feed.json だと判定できる', async () => {
  const { isFeedRequest } = await loadSw({ fetchImpl: async () => new FakeResponse('{}') });
  assert.equal(isFeedRequest(new URL('https://example.test/feed.json')), true);
  assert.equal(isFeedRequest(new URL('https://example.test/feed.sample.json')), true);
  assert.equal(isFeedRequest(new URL('https://example.test/feed.json?v=2')), true);
  assert.equal(isFeedRequest(new URL('https://example.test/app.js')), false);
});

test('通信できるときは、キャッシュがあっても新しいほうを返す', async () => {
  let called = 0;
  const { feedNetworkFirst, sandbox } = await loadSw({
    fetchImpl: async () => { called += 1; return new FakeResponse('{"generatedAt":"new"}'); },
  });
  const req = { url: 'https://example.test/feed.json' };

  // 先にキャッシュへ古いものを入れておく
  const cache = await sandbox.caches.open('tcg-watch-runtime-v3');
  await cache.put(req, new FakeResponse('{"generatedAt":"old"}'));

  const res = await feedNetworkFirst(req);
  assert.equal(await res.text(), '{"generatedAt":"new"}');
  assert.equal(called, 1, '通信を試していない');
});

test('通信できたら、そのままキャッシュを新しくする', async () => {
  const { feedNetworkFirst, sandbox } = await loadSw({
    fetchImpl: async () => new FakeResponse('{"generatedAt":"new"}'),
  });
  const req = { url: 'https://example.test/feed.json' };
  await feedNetworkFirst(req);
  const cache = await sandbox.caches.open('tcg-watch-runtime-v3');
  const stored = await cache.match(req);
  assert.ok(stored, 'キャッシュに入っていない');
  assert.equal(await stored.text(), '{"generatedAt":"new"}');
});

test('圏外ならキャッシュを返す（画面を真っ白にしない）', async () => {
  const { feedNetworkFirst, sandbox } = await loadSw({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const req = { url: 'https://example.test/feed.json' };
  const cache = await sandbox.caches.open('tcg-watch-runtime-v3');
  await cache.put(req, new FakeResponse('{"generatedAt":"old"}'));

  const res = await feedNetworkFirst(req);
  assert.equal(await res.text(), '{"generatedAt":"old"}');
});

test('圏外でキャッシュも無ければ 503 を返す（例外で落とさない）', async () => {
  const { feedNetworkFirst } = await loadSw({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const res = await feedNetworkFirst({ url: 'https://example.test/feed.json' });
  assert.equal(res.status, 503);
});

test('サーバーが404を返したらキャッシュに落とす（404を配らない）', async () => {
  const { feedNetworkFirst, sandbox } = await loadSw({
    fetchImpl: async () => new FakeResponse('not found', { status: 404 }),
  });
  const req = { url: 'https://example.test/feed.json' };
  const cache = await sandbox.caches.open('tcg-watch-runtime-v3');
  await cache.put(req, new FakeResponse('{"generatedAt":"old"}'));
  const res = await feedNetworkFirst(req);
  assert.equal(await res.text(), '{"generatedAt":"old"}');
});

test('通信が遅すぎるときは待ち続けずキャッシュを出す', async () => {
  const { feedNetworkFirst, sandbox } = await loadSw({
    // 3秒の制限より遅い応答
    fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve(new FakeResponse('{"generatedAt":"slow"}')), 5000)),
  });
  const req = { url: 'https://example.test/feed.json' };
  const cache = await sandbox.caches.open('tcg-watch-runtime-v3');
  await cache.put(req, new FakeResponse('{"generatedAt":"old"}'));

  const started = Date.now();
  const res = await feedNetworkFirst(req);
  const waited = Date.now() - started;

  assert.equal(await res.text(), '{"generatedAt":"old"}');
  assert.ok(waited < 4500, `待ちすぎている: ${waited}ms`);
});
