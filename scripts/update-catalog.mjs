#!/usr/bin/env node
/**
 * ちいかわ ご当地キーホルダー カタログ自動更新
 *
 *   npm run update-list              … 取得して chiikawa_checklist_claude.html の FULL を書き換える
 *   npm run update-list -- --dry-run … 書き換えずに差分レポートだけ出す
 *
 * 方針:
 *   - kakkon.net をカタログの主ソースにする（都道府県が取れる唯一のソース）
 *   - jp-api.com（公式メーカー）は「その商品が現行商品として載っているか」の裏取りに使う
 *   - FULL からの削除は絶対にしない。消えた候補はレポートに出すだけ。
 *     FULL から消すと、アプリ側の sanitize() が該当する所持チェックを捨ててしまうため。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchKakkon } from './sources/kakkon.mjs';
import { fetchJpApi } from './sources/jpapi.mjs';
import { normName } from './sources/fetch-util.mjs';
// エリア・名称の解決は fetch-images.mjs と共有する（ずれると画像が別商品に付く）
import { resolveAlias, keyOf, UNCLASSIFIED } from './resolve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_HTML = join(ROOT, 'chiikawa_checklist_claude.html');
const REPORT_MD = join(HERE, 'catalog-report.md');

const MARK_START = '// <<<AUTO-CATALOG-START>>>';
const MARK_END = '// <<<AUTO-CATALOG-END>>>';

/** アプリ側 (chiikawa_checklist_claude.html) の REGION_ORDER / PREF_ORDER と揃えること */
const REGION_ORDER = [
  '北海道地方', '東北地方', '関東地方', '中部地方', '近畿地方',
  '中国地方', '四国地方', '九州地方', '海外', 'その他', '未分類',
];
const PREF_ORDER = [
  '北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島',
  '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川',
  '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知',
  '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山',
  '鳥取', '島根', '岡山', '広島', '山口',
  '徳島', '香川', '愛媛', '高知',
  '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄',
];

const regionRank = (r) => { const i = REGION_ORDER.indexOf(r); return i >= 0 ? i : 999; };
const prefRank = (p) => { const i = PREF_ORDER.indexOf(p); return i >= 0 ? i : 999; };

function sortCatalog(list) {
  return [...list].sort((a, b) =>
    regionRank(a.region) - regionRank(b.region) ||
    prefRank(a.pref) - prefRank(b.pref) ||
    a.pref.localeCompare(b.pref, 'ja') ||
    a.name.localeCompare(b.name, 'ja'));
}

/** HTML から現行 FULL を読む。マーカーの有無どちらでも動く */
function parseFull(html) {
  const m = html.match(/const\s+FULL\s*=\s*\[([\s\S]*?)\n\s*\];/);
  if (!m) throw new Error('chiikawa_checklist_claude.html の中に FULL 配列が見つかりませんでした。');
  const items = [];
  const re = /\{\s*region:\s*"([^"]*)"\s*,\s*pref:\s*"([^"]*)"\s*,\s*name:\s*"([^"]*)"\s*\}/g;
  for (const it of m[1].matchAll(re)) {
    items.push({ region: it[1], pref: it[2], name: it[3] });
  }
  if (items.length === 0) throw new Error('FULL 配列の中身を読み取れませんでした。');
  return items;
}

function renderFull(catalog) {
  const lines = sortCatalog(catalog)
    .map(x => `    {region:"${x.region}",pref:"${x.pref}",name:"${x.name}"}`)
    .join(',\n');
  return [
    `  ${MARK_START} scripts/update-catalog.mjs が自動生成します。手で編集しないでください。`,
    '  const FULL=[',
    lines,
    '  ];',
    `  ${MARK_END}`,
  ].join('\n');
}

/** HTML 中の FULL ブロックを差し替える。初回はマーカーが無いので裸の FULL を探す */
function replaceFullBlock(html, block) {
  const marked = new RegExp(`[ \\t]*${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}`);
  if (marked.test(html)) return html.replace(marked, block);

  const bare = /[ \t]*const\s+FULL\s*=\s*\[[\s\S]*?\n\s*\];/;
  if (!bare.test(html)) throw new Error('FULL 配列を置換できませんでした。');
  return html.replace(bare, block);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const [aliasFile, areaMap] = await Promise.all([
    readFile(join(HERE, 'name-map.json'), 'utf8').then(JSON.parse),
    readFile(join(HERE, 'area-map.json'), 'utf8').then(JSON.parse),
  ]);
  const aliases = aliasFile.aliases ?? {};
  const jpapiToKakkon = aliasFile.jpapiToKakkon ?? {};

  console.error('kakkon.net を取得中…');
  const kakkonRows = await fetchKakkon();
  console.error(`  → ${kakkonRows.length} 件`);

  // jp-api.com は裏取り専用なので、落ちていてもカタログ更新自体は続行する。
  // 都道府県を含む本体のデータは kakkon.net 側に揃っている。
  console.error('jp-api.com を取得中…');
  let jpapiRows = [], jpapiError = null;
  try {
    jpapiRows = await fetchJpApi();
    console.error(`  → ${jpapiRows.length} 件`);
  } catch (e) {
    jpapiError = e.message || String(e);
    console.error(`  → 取得できませんでした（裏取りはスキップして続行します）: ${jpapiError}`);
  }

  // jp-api 側の名称を kakkon の表記に寄せてから、正規化して裏取り用の集合にする
  const jpapiNames = new Map(); // normName(kakkon表記) -> types[]
  for (const r of jpapiRows) {
    const asKakkon = jpapiToKakkon[r.name] ?? jpapiToKakkon[normName(r.name)] ?? r.name;
    jpapiNames.set(normName(asKakkon), r.types);
  }

  const html = await readFile(APP_HTML, 'utf8');
  const current = parseFull(html);

  // 「Ｅ７ / E7」「温泉♨ / 温泉」「東京駅 丸の内駅舎 / 東京駅丸の内駅舎」のような
  // 表記ゆれで既存項目を新規扱いしないよう、正規化キーで既存項目を引けるようにする。
  const normKey = (x) => `${x.region}__${x.pref}__${normName(x.name)}`;
  const currentByNorm = new Map(current.map(x => [normKey(x), x]));

  // --- kakkon の各行を {region, pref, name} に解決する ---
  const catalog = [];
  const seen = new Map();
  const unknownAreas = [];

  for (const row of kakkonRows) {
    const mapped = areaMap[row.area];
    if (!mapped) unknownAreas.push(row);
    const [region, pref] = mapped ?? [UNCLASSIFIED, ''];
    let name = resolveAlias(aliases, row.name, row.area);

    // 既に同じ商品が FULL にあるなら、そちらの表記をそのまま使う。
    // 名称を勝手に書き換えるとキーが変わり、所持チェックが行方不明になるため。
    const existing = currentByNorm.get(`${region}__${pref}__${normName(name)}`);
    if (existing) name = existing.name;

    const entry = {
      region, pref, name,
      _srcName: row.name,
      _area: row.area,
      _types: jpapiNames.get(normName(row.name)) ?? null,
    };
    const k = keyOf(entry);
    if (seen.has(k)) continue; // 同一商品が両ソースの記事に重複掲載されている場合
    seen.set(k, entry);
    catalog.push(entry);
  }

  // --- 現行 FULL と突合 ---
  const currentKeys = new Set(current.map(keyOf));
  const catalogKeys = new Set(catalog.map(keyOf));

  const added = catalog.filter(x => !currentKeys.has(keyOf(x)));
  const missing = current.filter(x => !catalogKeys.has(keyOf(x)));
  // jp-api が取れなかった回は全件が「未確認」になってしまうので、裏取りの判定自体を伏せる
  const unconfirmed = jpapiError ? [] : catalog.filter(x => x._types === null);

  // FULL からは削除しない。消えた候補もそのまま残す。
  const merged = [
    ...current,
    ...added.map(({ region, pref, name }) => ({ region, pref, name })),
  ];

  // --- レポート ---
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const L = [];
  L.push('# ご当地ちいかわ カタログ差分レポート', '');
  L.push(`生成: ${now}`, '');
  L.push(`- kakkon.net: **${kakkonRows.length} 件**（エリア ${new Set(kakkonRows.map(r => r.area)).size} 種）`);
  L.push(jpapiError
    ? `- jp-api.com: **取得できず**（裏取りをスキップして続行しました）`
    : `- jp-api.com: **${jpapiRows.length} 件**（キーホルダー系のみ）`);
  L.push(`- 現行 FULL: **${current.length} 件** → 更新後 **${merged.length} 件**`, '');

  if (jpapiError) {
    L.push('## ⚠️ 公式サイト（jp-api.com）を取得できませんでした', '');
    L.push('```', jpapiError, '```', '');
    L.push('都道府県を含む商品情報は kakkon.net 側に揃っているため、カタログの更新はそのまま行いました。');
    L.push('ただし「その商品が公式の現行商品として載っているか」の裏取りは今回できていません。', '');
  }

  if (unknownAreas.length) {
    L.push(`## ⚠️ area-map.json に無いエリア（${unknownAreas.length} 件）`, '');
    L.push('`未分類` として追加しました。`scripts/area-map.json` に地域・都道府県を追記して再実行してください。', '');
    L.push('| エリア | 商品名 |', '|---|---|');
    for (const r of unknownAreas) L.push(`| ${r.area} | ${r.name} |`);
    L.push('');
  }

  L.push(`## 🆕 新規追加（${added.length} 件）`, '');
  if (added.length) {
    L.push('| 地域 | 都道府県 | 名称 | kakkon 表記 | エリア | 公式(jp-api) |', '|---|---|---|---|---|---|');
    for (const x of added) {
      const official = jpapiError ? '—（取得できず）' : (x._types ? x._types.join(' / ') : '❓未掲載');
      L.push(`| ${x.region} | ${x.pref} | ${x.name} | ${x._srcName} | ${x._area} | ${official} |`);
    }
  } else {
    L.push('なし。');
  }
  L.push('');

  if (!jpapiError) {
    L.push(`## ℹ️ 公式サイト（jp-api.com）で確認できなかった商品（${unconfirmed.length} 件）`, '');
    if (unconfirmed.length) {
      L.push('kakkon.net には載っているが公式の商品一覧に見当たらないもの。掲載漏れの可能性が高いので**削除はしません**。', '');
      L.push('| 地域 | 都道府県 | 名称 | kakkon 表記 |', '|---|---|---|---|');
      for (const x of unconfirmed) L.push(`| ${x.region} | ${x.pref} | ${x.name} | ${x._srcName} |`);
    } else {
      L.push('なし。');
    }
    L.push('');
  }

  L.push(`## 🔍 どちらのソースにも見当たらない既存項目（${missing.length} 件）`, '');
  if (missing.length) {
    L.push('**削除していません**（所持チェックを失わないため）。名称の表記ゆれなら `scripts/name-map.json` に追記してください。', '');
    L.push('| 地域 | 都道府県 | 名称 |', '|---|---|---|');
    for (const x of missing) L.push(`| ${x.region} | ${x.pref} | ${x.name} |`);
  } else {
    L.push('なし。');
  }
  L.push('');

  const report = L.join('\n');
  await writeFile(REPORT_MD, report + '\n', 'utf8');
  console.log(report);

  if (dryRun) {
    console.error('\n--dry-run のため HTML は書き換えていません。');
  } else if (added.length === 0 && replaceFullBlock(html, renderFull(merged)) === html) {
    console.error('\n変更はありませんでした。');
  } else {
    await writeFile(APP_HTML, replaceFullBlock(html, renderFull(merged)), 'utf8');
    console.error(`\n${APP_HTML} の FULL を更新しました（${current.length} → ${merged.length} 件）。`);
    console.error('デプロイする場合は:  cp chiikawa_checklist_claude.html public/index.html && firebase deploy --only hosting');
  }

  if (unknownAreas.length) process.exitCode = 0; // PR で人が見るのでエラー終了はしない
}

await main();
