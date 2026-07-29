#!/usr/bin/env node
/**
 * 商品写真を取得して public/images/items/ に保存し、
 * chiikawa_checklist_claude.html の画像マップを書き換える。
 *
 *   npm run fetch-images              … 未取得のものだけ落とす
 *   npm run fetch-images -- --force   … 既にあるものも上書きする
 *   npm run fetch-images -- --dry-run … 何を落とすか出すだけ
 *
 * 取得元は kakkon.net の記事。公式メーカー（jp-api.com）に商品画像はあるが、
 * サイトが落ちている間は取得できないため、当面こちらを使う。
 *
 * 画像は macOS の sips で 240px に縮小して JPEG にする。原寸のままだと
 * リポジトリが重くなるうえ、タイルは 112px 程度しか使わないため。
 */

import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchText, sleep, stripTags, normName } from './sources/fetch-util.mjs';
import { KAKKON_PAGES } from './sources/kakkon.mjs';
import { loadMaps, resolveRow, keyOf, fileKey } from './resolve.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_HTML = join(ROOT, 'chiikawa_checklist_claude.html');
const OUT_DIR = join(ROOT, 'public', 'images', 'items');

const MARK_START = '// <<<AUTO-IMAGES-START>>>';
const MARK_END = '// <<<AUTO-IMAGES-END>>>';
const MAX_PX = 240;

const CAPTION_RE = /<div style="line-height: 1\.6;[^"]*">([\s\S]*?)<\/div>/;
const IMG_RE = /(?:data-src|src)="(https:\/\/kakkon\.net\/[^"]+?\.(?:jpg|jpeg|png|webp))"/i;

/** 記事から {area, name, imgUrl} を集める */
async function scrapeWithImages(){
  const rows = [];
  for(const [i, url] of KAKKON_PAGES.entries()){
    if(i > 0) await sleep(1000);
    const html = await fetchText(url);
    // 商品は td 単位で「画像 + キャプション」が並ぶ
    for(const cell of html.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []){
      const cap = CAPTION_RE.exec(cell);
      if(!cap) continue;
      const text = stripTags(cap[1]).replace(/\s+/g, ' ').trim();
      const nameM = /「([^」]+)」/.exec(text);
      const areaM = /^(.+?)限定/.exec(text);
      const imgM = IMG_RE.exec(cell);
      if(!nameM || !areaM || !imgM) continue;
      rows.push({ area: areaM[1].trim(), name: nameM[1].trim(), imgUrl: imgM[1] });
    }
  }
  if(!rows.length) throw new Error('kakkon.net から画像付きの商品を1件も取得できませんでした。HTML構造が変わった可能性があります。');
  return rows;
}

async function fileExists(p){
  try { await stat(p); return true; } catch { return false; }
}

async function download(url, dest){
  const res = await fetch(url, { headers: { 'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if(buf.length < 500) throw new Error(`小さすぎる応答 (${buf.length}B)`);
  await writeFile(dest, buf);
  return buf.length;
}

/** 240px の JPEG に落とす。sips が無い環境ではそのまま置く */
async function shrink(src, dest){
  try{
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70',
                       '-Z', String(MAX_PX), src, '--out', dest]);
    return true;
  }catch(e){
    console.error(`  sips で縮小できませんでした（原寸のまま使います）: ${e.message.split('\n')[0]}`);
    return false;
  }
}

function replaceBlock(html, block){
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marked = new RegExp(`[ \\t]*${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}`);
  if(marked.test(html)) return html.replace(marked, block);
  // 初回はアイコン定義の直前に差し込む
  const anchor = '  /* ===== タイルのアイコン =====';
  if(!html.includes(anchor)) throw new Error('画像マップの挿入位置が見つかりませんでした。');
  return html.replace(anchor, block + '\n\n' + anchor);
}

async function main(){
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  const maps = await loadMaps();
  console.error('kakkon.net から画像URLを収集中…');
  const rows = await scrapeWithImages();
  console.error(`  → ${rows.length} 件`);

  // 現行カタログのキー集合。カタログに無い商品の画像は落とさない
  const html = await readFile(APP_HTML, 'utf8');
  const catalogEntries = [...html.matchAll(/\{region:"([^"]*)",pref:"([^"]*)",name:"([^"]*)"\}/g)]
    .map(m => ({ region:m[1], pref:m[2], name:m[3] }));
  const catalogKeys = new Set(catalogEntries.map(keyOf));
  // 「Ｎ７００Ｓ / N700S」「温泉♨ / 温泉」のような表記ゆれでも拾えるように、
  // 正規化キーからカタログの正式キーを引ける索引も持つ
  const byNorm = new Map(catalogEntries.map(e =>
    [`${e.region}__${e.pref}__${normName(e.name)}`, keyOf(e)]));

  await mkdir(OUT_DIR, { recursive: true });

  const map = {};           // カタログキー → ファイル名
  const skipped = [];       // カタログに無かったもの
  const failed = [];
  let got = 0, reused = 0;

  for(const row of rows){
    const item = resolveRow(row, maps);
    let key = keyOf(item);
    if(!catalogKeys.has(key)){
      key = byNorm.get(`${item.region}__${item.pref}__${normName(item.name)}`);
    }
    if(!key){ skipped.push(`${row.area} 「${row.name}」`); continue; }
    if(map[key]) continue;  // 同じ商品が複数回出てきたら最初のものを使う

    const file = fileKey(key) + '.jpg';
    map[key] = file;
    const dest = join(OUT_DIR, file);

    if(!force && await fileExists(dest)){ reused++; continue; }
    if(dryRun){ got++; continue; }

    const tmp = dest + '.orig';
    try{
      await download(row.imgUrl, tmp);
      const ok = await shrink(tmp, dest);
      if(!ok) await writeFile(dest, await readFile(tmp));
      await rm(tmp, { force: true });
      got++;
      process.stderr.write(`\r  取得 ${got} 件…`);
    }catch(e){
      await rm(tmp, { force: true });
      delete map[key];
      failed.push(`${row.name}: ${e.message}`);
    }
    await sleep(250);
  }
  if(got) process.stderr.write('\n');

  // 使われなくなった画像を掃除する
  const used = new Set(Object.values(map));
  const orphans = (await readdir(OUT_DIR)).filter(f => f.endsWith('.jpg') && !used.has(f));
  if(!dryRun) for(const f of orphans) await rm(join(OUT_DIR, f), { force: true });

  const total = Object.keys(map).length;
  console.error(`\n画像あり ${total} / カタログ ${catalogKeys.size} 件`);
  console.error(`  新規取得 ${got} / 既存流用 ${reused} / 失敗 ${failed.length} / 不要削除 ${orphans.length}`);
  if(skipped.length) console.error(`  カタログに無いためスキップ: ${skipped.length} 件`);
  if(failed.length) console.error('  失敗:\n    ' + failed.join('\n    '));

  const missing = [...catalogKeys].filter(k => !map[k]);
  if(missing.length){
    console.error(`\n画像が無い商品（アイコン表示のまま） ${missing.length} 件:`);
    for(const k of missing) console.error('    ' + k.split('__').join(' / '));
  }

  if(dryRun){ console.error('\n--dry-run のため保存も書き換えもしていません。'); return; }

  const entries = Object.entries(map).sort(([a],[b]) => a.localeCompare(b,'ja'))
    .map(([k,v]) => `    ${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n');
  const block = [
    `  ${MARK_START} scripts/fetch-images.mjs が自動生成します。手で編集しないでください。`,
    '  const IMG = {',
    entries,
    '  };',
    `  ${MARK_END}`,
  ].join('\n');

  await writeFile(APP_HTML, replaceBlock(html, block), 'utf8');
  console.error(`\n${APP_HTML} の画像マップを更新しました。`);
}

await main();
