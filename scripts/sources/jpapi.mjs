/**
 * 公式メーカー ㈱API（jp-api.com）の「ご当地 ちいかわ」商品一覧を取得する。
 *
 * こちらは裏取り用。商品として実在するか、ダイカット／ぬいぐるみのどちらが
 * 出ているかが分かる。ただし都道府県の情報は一切載っていない。
 *
 * ・配信は Shift_JIS
 * ・キーホルダー以外（靴下・ポーチ・巾着・がま口・記念メダル等）も同じ一覧に混ざる
 */

import { fetchText, sleep } from './fetch-util.mjs';

const BASE = 'https://www.jp-api.com/contents/NOD62/';
const CHARSET = 'shift_jis';

/** 取り込み対象の商品タイプ。これ以外（靴下等）は無視する */
export const KEYHOLDER_TYPES = ['ダイカットキーホルダー', 'ぬいぐるみキーチェーン'];

const ITEM_RE = /<p class="img_023 img"><a href="([^"]+)" class="lightbox" rel="item" title="([^"]*)"/g;
const PAGE_RE = /\/contents\/NOD62\/PGE(\d+)\//g;

/** @returns {Promise<{name:string,types:string[],img:string|null}[]>} */
export async function fetchJpApi() {
  const first = await fetchText(BASE, CHARSET);

  // ページャから総ページ数を拾う（将来7ページ目が増えても追従させる）
  let maxPage = 1;
  for (const m of first.matchAll(PAGE_RE)) maxPage = Math.max(maxPage, Number(m[1]));
  if (maxPage > 30) throw new Error(`jp-api.com のページ数が異常です (${maxPage})。HTML構造が変わった可能性があります。`);

  const pages = [first];
  for (let p = 2; p <= maxPage; p++) {
    await sleep(1000);
    pages.push(await fetchText(`${BASE}PGE${p}/`, CHARSET));
  }

  const byName = new Map();
  let totalItems = 0;

  for (const html of pages) {
    for (const m of html.matchAll(ITEM_RE)) {
      totalItems++;
      const href = m[1];
      const title = m[2].trim();
      const type = KEYHOLDER_TYPES.find(t => title.endsWith(t));
      if (!type) continue; // 靴下等はスキップ
      const name = title.slice(0, -type.length).replace(/[\s　]+$/, '').trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, { types: new Set(), imgs: {} });
      const e = byName.get(name);
      e.types.add(type);
      // 商品画像も拾っておく（画像取得スクリプトが使う）
      if (href && !e.imgs[type]) e.imgs[type] = new URL(href, BASE).href;
    }
  }

  if (totalItems === 0) {
    throw new Error('jp-api.com から1件も取得できませんでした。HTML構造が変わった可能性があります。');
  }

  // 画像は種類ごとに分けて返す。呼び出し側で「キーホルダーの画像が欲しい」
  // という区別ができるようにするため（ぬいぐるみキーチェーンは別商品）。
  return [...byName].map(([name, e]) => ({
    name,
    types: [...e.types],
    imgDiecut: e.imgs['ダイカットキーホルダー'] || null,
    imgPlush:  e.imgs['ぬいぐるみキーチェーン'] || null,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await fetchJpApi();
  for (const r of rows) console.log(`${r.name}\t${r.types.join('/')}\t${r.imgDiecut ? 'ダイカット画像あり' : 'ダイカット画像なし'}`);
  console.error(`\nキーホルダー系ユニーク ${rows.length} 件`);
}
