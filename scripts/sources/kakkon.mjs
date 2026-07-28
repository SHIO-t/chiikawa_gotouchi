/**
 * kakkon.net の「ご当地ちいかわキーホルダー全紹介」記事からカタログを取得する。
 *
 * カタログの主ソース。エリア（＝都道府県相当）を持つ唯一のソースで、
 * 「みかん」（静岡/和歌山/愛媛）のような同名別エリアの商品も区別できる。
 *
 * 各商品は下記の形のキャプション div として並んでいる:
 *   <div style="line-height: 1.6; font-weight:bold;…">
 *     〇〇限定ちいかわ<br>「名称」<small>🧦靴下🧸ぬい</small>
 *   </div>
 * 「名称」が <small> の中に入っている商品（水戸納豆・行徳みこし・落花生）が
 * あるので、タグを落としてから 「」 を探すこと。
 */

import { fetchText, stripTags, sleep } from './fetch-util.mjs';

export const KAKKON_PAGES = [
  'https://kakkon.net/chiikawa-gotochi/',
  'https://kakkon.net/chiikawa-gotochi-west/',
];

const CAPTION_RE = /<div style="line-height: 1\.6;[^"]*">([\s\S]*?)<\/div>/g;

/** @returns {Promise<{area:string,name:string,source:string}[]>} */
export async function fetchKakkon() {
  const out = [];
  let noArea = 0;

  for (const [i, url] of KAKKON_PAGES.entries()) {
    if (i > 0) await sleep(1000);
    const html = await fetchText(url);

    for (const m of html.matchAll(CAPTION_RE)) {
      const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();

      const nameM = text.match(/「([^」]+)」/);
      if (!nameM) continue; // 商品キャプションではない div

      const areaM = text.match(/^(.+?)限定/);
      if (!areaM) { noArea++; continue; }

      out.push({
        area: areaM[1].trim(),
        name: nameM[1].trim(),
        source: url,
      });
    }
  }

  if (out.length === 0) {
    throw new Error('kakkon.net から1件も取得できませんでした。記事のHTML構造が変わった可能性があります。');
  }
  if (noArea > 5) {
    throw new Error(`kakkon.net でエリア名を取得できないキャプションが ${noArea} 件ありました。HTML構造が変わった可能性があります。`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await fetchKakkon();
  for (const r of rows) console.log(`${r.area}\t${r.name}`);
  console.error(`\n合計 ${rows.length} 件 / エリア ${new Set(rows.map(r => r.area)).size} 種`);
}
