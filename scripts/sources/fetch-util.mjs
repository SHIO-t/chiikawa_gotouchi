/**
 * 取得まわりの共通処理。外部サイトに負荷をかけないよう直列＋ウェイトで取る。
 */

// jp-api.com は WAF が独自 User-Agent を 406 で弾くため、一般的なブラウザの UA を送る。
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {string} [charset] 'shift_jis' など。省略時は UTF-8
 * @returns {Promise<string>}
 */
export async function fetchText(url, charset) {
  // jp-api.com の WAF は Accept / Accept-Language を付けると 406 を返すため、
  // 送るヘッダは User-Agent だけに留めること。
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  if (!charset) return await res.text();
  const buf = await res.arrayBuffer();
  return new TextDecoder(charset).decode(buf);
}

/** HTML断片からタグを落としてテキストにする（<br>等は区切りとして空白に潰す） */
export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '));
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 商品名の正規化。全角半角・記号・空白のゆれを吸収して突合用のキーにする。
 * name-map.json に書かなくても済む差はここで吸収される。
 */
export function normName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[®™♨]/g, '')
    .replace(/ヶ/g, 'ケ')
    .replace(/\s+/g, '')
    .trim();
}
