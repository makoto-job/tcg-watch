/**
 * tools/build-single.mjs
 *
 * app/ の複数ファイルを1枚のHTMLにまとめる。
 * Artifact など「単一HTMLしか置けない場所」で動作確認するための版。
 *
 * ・CSS と JS をインライン化
 * ・feed.json を埋め込み、fetch せずに起動できるようにする
 *   （ネットワーク不可の環境でも中身を確認できる）
 * ・Service Worker とマニフェストは単一ファイルでは使えないので外す
 *
 * 使い方: node tools/build-single.mjs [出力先]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(process.argv[2] || join(root, 'public/app-single.html'));

const read = (p) => readFile(join(root, p), 'utf8');

// app.js が読み込むモジュールを全て取り込む。
// ここに書き漏らすと単一ファイル版だけ 404 になり、機能が丸ごと無効化される。
const MODULES = ['config.js', 'crypto.js', 'profile.js'];

const [html, css, appJs, feed, shops, ...moduleSources] = await Promise.all([
  read('app/index.html'),
  read('app/style.css'),
  read('app/app.js'),
  read('public/feed.json'),
  // 店の一覧。これが読めないと「この店は通販か実店舗か」の判定が
  // 店名の見た目だけに頼ることになり、紀伊國屋書店などを実店舗と誤判定する。
  read('config/shops.json'),
  ...MODULES.map((m) => read(`app/${m}`)),
]);

// app.js が実際に import しているモジュールが MODULES に揃っているか検算する
const imported = [...appJs.matchAll(/from\s+['"]\.\/([\w.-]+\.js)['"]/g)].map((m) => m[1]);
const missing = imported.filter((m) => !MODULES.includes(m));
if (missing.length) {
  throw new Error(
    `単一ファイル版に取り込まれていないモジュールがあります: ${missing.join(', ')}\n` +
      `tools/build-single.mjs の MODULES に追加してください。`
  );
}

// モジュールを素朴に連結すると、同名のローカル変数（storage など）が衝突して
// SyntaxError になり、単一ファイル版だけ機能が丸ごと死ぬ。
// そこで各モジュールをIIFEで包み、export しているものだけを名前空間として公開する。
const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

const nsName = (file) => '__m_' + file.replace(/[^\w]/g, '_');

const wrapped = MODULES.map((file, idx) => {
  const src = moduleSources[idx];
  const names = [...src.matchAll(EXPORT_RE)].map((m) => m[1]);
  if (!names.length) throw new Error(`${file}: export が見つかりません`);
  const body = src.replace(/^(\s*)export\s+/gm, '$1');
  return `const ${nsName(file)} = (function () {\n${body}\nreturn { ${names.join(', ')} };\n})();`;
});
const configInline = wrapped.join('\n\n');

// app.js の import 文を、名前空間からの分割代入に置き換える
let appInline = appJs;
for (const file of MODULES) {
  const esc = file.replace(/\./g, '\\.');
  // import { A, B } from './x.js';  （複数行にまたがる場合も含む）
  // 中括弧を含まない文字だけを許すのが要点。[\s\S]*? だと後方一致が
  // 次の import まで伸びて、手前の import 文ごと飲み込んでしまう。
  appInline = appInline.replace(
    new RegExp(`^[ \\t]*import\\s+\\{([^{}]*)\\}\\s+from\\s+['"]\\./${esc}['"];?[ \\t]*$`, 'gm'),
    (_m, names) => `const {${names}} = ${nsName(file)};`
  );
}

let s = html;

// 単一ファイルでは使えない参照を外す
s = s.replace(/^.*<link rel="manifest"[^>]*>.*$/gm, '');
s = s.replace(/^.*<link rel="apple-touch-icon"[^>]*>.*$/gm, '');

// CSS をインライン化
s = s.replace(/^.*<link rel="stylesheet" href="\.\/style\.css">.*$/gm, `<style>\n${css}\n</style>`);

// JS をインライン化。feed は埋め込み済みデータを使う
const bootstrap = `
<script type="application/json" id="embedded-feed">${JSON.stringify(JSON.parse(feed))}</script>
<script type="application/json" id="embedded-shops">${JSON.stringify(JSON.parse(shops))}</script>
<script type="module">
// --- 単一ファイル版 ---
// feed.json を取りに行かず、埋め込んだデータを返す。
// これによりオフラインでも、また静的ホスティングが無くても動作する。
const __embedded = JSON.parse(document.getElementById('embedded-feed').textContent);
const __embeddedShops = JSON.parse(document.getElementById('embedded-shops').textContent);
const __origFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '');
  if (/feed(\\.sample)?\\.json/.test(url)) {
    return new Response(JSON.stringify(__embedded), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (/shops\\.json/.test(url)) {
    return new Response(JSON.stringify(__embeddedShops), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (__origFetch) return __origFetch(input, init);
  throw new Error('fetch unavailable');
};
// Service Worker は単一ファイルでは登録できないので無効化する
if ('serviceWorker' in navigator) {
  try {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: () => Promise.reject(new Error('single-file build')), ready: new Promise(() => {}) },
      configurable: true,
    });
  } catch { /* 失敗しても致命的ではない */ }
}

${configInline}
${appInline}

/* --- 単一ファイル版であることを画面に明示する ---
   この版はデータを中に抱えているので、更新ボタンを押しても中身は変わらない。
   黙っていると「更新しても古いまま」に見えるだけなので、理由を先に出しておく。 */
(function () {
  const stamp = ${JSON.stringify(JSON.parse(feed).generatedAt)};
  const when = stamp ? new Date(stamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '不明';

  function mount() {
    if (document.getElementById('single-note')) return;
    const host = document.querySelector('main') || document.body;
    const note = document.createElement('p');
    note.id = 'single-note';
    note.setAttribute('role', 'note');
    note.style.cssText =
      'margin:8px 12px;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.6;' +
      'background:var(--bg-sunken,#f1f2f6);color:var(--text-sub,#555);border:1px dashed var(--border,#ccd);';
    note.textContent =
      'この1枚版は ' + when + ' 時点の見本です。中にデータを抱えているため、' +
      '更新ボタンを押しても新しくなりません。最新の情報は公開版でご覧ください。';
    host.insertBefore(note, host.firstChild);
  }

  function arm() {
    mount();
    const btn = document.getElementById('btnRefresh');
    if (btn && !btn.dataset.singleNoted) {
      btn.dataset.singleNoted = '1';
      btn.addEventListener('click', () => {
        const n = document.getElementById('single-note');
        if (!n) return;
        n.style.transition = 'background 200ms';
        const orig = n.style.background;
        n.style.background = 'var(--warn-bg,#fdf0d5)';
        n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => { n.style.background = orig; }, 900);
      }, { capture: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
  else arm();
})();
</script>`;

s = s.replace(/^.*<script type="module" src="\.\/app\.js"><\/script>.*$/gm, bootstrap);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, s, 'utf8');
console.log(`単一ファイル版を書き出しました: ${out}`);
console.log(`  サイズ: ${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)} KB`);
console.log(`  埋め込み記事: ${JSON.parse(feed).items.length}件`);
