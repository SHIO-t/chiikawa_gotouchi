/**
 * ソースサイトの「エリア＋商品名」を、アプリ側の {region, pref, name} に解決する。
 *
 * update-catalog.mjs（リスト更新）と fetch-images.mjs（画像取得）の両方から使う。
 * 両者で解決結果がずれると画像が別商品に付くので、必ずここを共有すること。
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normName } from './sources/fetch-util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const UNCLASSIFIED = '未分類';

export async function loadMaps(){
  const [nameMap, areaMap] = await Promise.all([
    readFile(join(HERE, 'name-map.json'), 'utf8').then(JSON.parse),
    readFile(join(HERE, 'area-map.json'), 'utf8').then(JSON.parse),
  ]);
  return {
    aliases: nameMap.aliases ?? {},
    jpapiToKakkon: nameMap.jpapiToKakkon ?? {},
    areaMap,
  };
}

/** name-map の照合。「名称@エリア」を優先し、無ければ「名称」で引く */
export function resolveAlias(aliases, name, area){
  const n = normName(name);
  const candidates = area ? [`${name}@${area}`, `${n}@${area}`, name, n] : [name, n];
  for(const c of candidates){
    if(Object.prototype.hasOwnProperty.call(aliases, c)) return aliases[c];
  }
  // キー側が未正規化で書かれている場合にも当たるよう、正規化同士でも突き合わせる
  for(const [k, v] of Object.entries(aliases)){
    if(k.includes('@')){
      const [kn, ka] = k.split('@');
      if(area && ka === area && normName(kn) === n) return v;
    }else if(normName(k) === n){
      return v;
    }
  }
  return name;
}

/**
 * kakkon の1行 → カタログ項目。
 * @returns {{region:string,pref:string,name:string,unknownArea:boolean}}
 */
export function resolveRow({ area, name }, maps){
  const mapped = maps.areaMap[area];
  const [region, pref] = mapped ?? [UNCLASSIFIED, ''];
  return {
    region, pref,
    name: resolveAlias(maps.aliases, name, area),
    unknownArea: !mapped,
  };
}

/** アプリ側 normalizedKey と同じ形（region__pref__name）。画像の紐付けキーにも使う */
export const keyOf = (x) => `${x.region}__${x.pref}__${x.name}`;

/** 画像ファイル名。日本語をURLに載せたくないので短いハッシュにする */
export const fileKey = (key) => createHash('sha1').update(key).digest('hex').slice(0, 12);
