/**
 * 区画D: 設定ローダー
 *
 * - `.env` を自前パース（dotenv非依存 / npm依存ゼロ）
 * - `config/sources.json` + `config/scoring.json` を読み込み
 * - 環境変数とマージした設定オブジェクトを返す
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** このファイル（src/config.js）から見たプロジェクトルート */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * プロジェクトルート基準でパスを解決する。
 * 絶対パスはそのまま返す。
 * @param {string} p
 * @returns {string}
 */
export function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/**
 * `.env` を自前パースする。
 *
 * 仕様:
 *  - `KEY=VALUE` 形式（`export KEY=VALUE` も可）
 *  - 行頭が `#` の行、空行は無視
 *  - キー・値の前後空白を trim
 *  - 値の前後のクォート（' または "）を1組だけ除去
 *  - **既存の `process.env` は上書きしない**
 *
 * @param {string} [envPath='.env'] 読み込む .env のパス（相対はプロジェクトルート基準）
 * @returns {Promise<Record<string,string>>} パース結果（ファイルが無ければ空オブジェクト）
 */
export async function loadEnv(envPath = '.env') {
  const file = resolveFromRoot(envPath);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`.env の読み込みに失敗しました（${file}）: ${err.message}`);
  }

  /** @type {Record<string,string>} */
  const parsed = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue; // '=' が無い / キーが空 の行は無視

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    // 前後のクォートを1組だけ除去
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    parsed[key] = value;

    // 既存の process.env を上書きしない
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
}

/**
 * JSON 設定ファイルを読み込む。無い / 壊れている場合は日本語で何が足りないかを示して throw。
 * @param {string} relPath
 * @param {string} label 人間向けラベル
 * @returns {Promise<any>}
 */
async function readJsonConfig(relPath, label) {
  const file = resolveFromRoot(relPath);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `設定ファイルが見つかりません: ${relPath}\n` +
          `  → ${label}の定義ファイルです。${file} を作成してください。\n` +
          `  → リポジトリを clone した直後であれば config/ ディレクトリが空の可能性があります。`
      );
    }
    throw new Error(`設定ファイルの読み込みに失敗しました: ${relPath}（${err.message}）`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `設定ファイルのJSONが壊れています: ${relPath}\n` +
        `  → ${err.message}\n` +
        `  → 末尾カンマ・コメント・クォート漏れが無いか確認してください（JSONにコメントは書けません）。`
    );
  }
}

/**
 * 数値の環境変数を安全に読む。
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function intOr(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @typedef {Object} AppConfig
 * @property {any} sources   config/sources.json の内容
 * @property {any} scoring   config/scoring.json の内容
 * @property {{
 *   xCreds: {apiKey:string, apiSecret:string, accessToken:string, accessTokenSecret:string},
 *   topN: number,
 *   postStyle: 'thread'|'single',
 *   tz: string,
 *   xReadEnabled: boolean,
 *   xBearerToken: string,
 *   feedUrl: string
 * }} env
 */

/**
 * 設定一式を読み込む。
 * @param {{ envPath?: string, sourcesPath?: string, scoringPath?: string }} [opts]
 * @returns {Promise<AppConfig>}
 */
export async function loadConfig(opts = {}) {
  const {
    envPath = '.env',
    sourcesPath = 'config/sources.json',
    scoringPath = 'config/scoring.json',
  } = opts;

  await loadEnv(envPath);

  const missing = [];
  let sources;
  let scoring;

  try {
    sources = await readJsonConfig(sourcesPath, '情報源（RSSフィード / IPキーワード）');
  } catch (err) {
    missing.push(err.message);
  }
  try {
    scoring = await readJsonConfig(scoringPath, 'スコアリングの重み');
  } catch (err) {
    missing.push(err.message);
  }

  if (missing.length > 0) {
    throw new Error(`設定の読み込みに失敗しました。\n\n${missing.join('\n\n')}`);
  }

  const e = process.env;

  const postStyleRaw = (e.POST_STYLE || 'thread').trim();
  const postStyle = postStyleRaw === 'single' ? 'single' : 'thread';

  return {
    sources,
    scoring,
    env: {
      xCreds: {
        apiKey: (e.X_API_KEY || '').trim(),
        apiSecret: (e.X_API_SECRET || '').trim(),
        accessToken: (e.X_ACCESS_TOKEN || '').trim(),
        accessTokenSecret: (e.X_ACCESS_TOKEN_SECRET || '').trim(),
      },
      topN: intOr(e.TOP_N, 3),
      postStyle,
      tz: (e.TZ || 'Asia/Tokyo').trim(),
      xReadEnabled: String(e.X_READ_ENABLED || '').trim().toLowerCase() === 'true',
      xBearerToken: (e.X_BEARER_TOKEN || '').trim(),
      feedUrl: (e.FEED_URL || '').trim(),
    },
  };
}

/**
 * X API の認証情報が4つとも揃っているか。
 * @param {AppConfig|{env?:{xCreds?:any}}} config
 * @returns {boolean}
 */
export function hasXCreds(config) {
  const c = config?.env?.xCreds;
  if (!c) return false;
  return ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret'].every(
    (k) => typeof c[k] === 'string' && c[k].length > 0
  );
}

/**
 * 不足している認証情報のキー名一覧（案内表示用）。
 * @param {AppConfig} config
 * @returns {string[]}
 */
export function missingXCredKeys(config) {
  const c = config?.env?.xCreds || {};
  const map = {
    apiKey: 'X_API_KEY',
    apiSecret: 'X_API_SECRET',
    accessToken: 'X_ACCESS_TOKEN',
    accessTokenSecret: 'X_ACCESS_TOKEN_SECRET',
  };
  return Object.entries(map)
    .filter(([k]) => !c[k])
    .map(([, envName]) => envName);
}
