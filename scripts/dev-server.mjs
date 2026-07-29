#!/usr/bin/env node
/**
 * デプロイ前に手元で見るための静的サーバー（依存ゼロ）。
 *
 *   npm run dev        → http://localhost:8099/chiikawa_checklist_claude.html
 *
 * public/index.html ではなく、編集中の chiikawa_checklist_claude.html を直接見るためのもの。
 *
 * 必ず localhost で開くこと。Firebase Auth の承認済みドメインには localhost しか
 * 入っていないため、127.0.0.1 で開くと Google ログインが auth/unauthorized-domain で失敗する。
 * localhost が IPv4 と IPv6 のどちらに解決されても繋がるよう、両方の loopback で待ち受ける。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const handler = async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/chiikawa_checklist_claude.html';

  // 商品画像は public/ 配下にしか置かない（デプロイ先と同じ配置にするため）。
  // 編集中の HTML はリポジトリ直下にあるので、/images/ だけ public/ へ振り替える。
  const base = rel.startsWith('/images/') ? join(ROOT, 'public') : ROOT;

  // ルート外へ出るパスは拒否する
  const path = join(base, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(base)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
};

// loopback のみ。外部からは繋がらない
for (const host of ['127.0.0.1', '::1']) {
  const primary = host === '127.0.0.1';
  createServer(handler)
    .listen(PORT, host)
    // URL は実際に待ち受けを始めてから出す
    .on('listening', () => {
      if (primary) console.log(`http://localhost:${PORT}/chiikawa_checklist_claude.html`);
    })
    .on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        // もう一方の loopback が同じポートを使っているだけなら黙って諦める
        if (!primary) return;
        console.error(`\nポート ${PORT} は既に使われています。`);
        console.error(`すでにサーバーが動いているなら、そのまま http://localhost:${PORT}/chiikawa_checklist_claude.html を開いてください。`);
        console.error(`止めたい場合:  pkill -f dev-server.mjs`);
        console.error(`別のポートで動かす場合:  PORT=8100 npm run dev\n`);
        process.exit(1);
      }
      // ::1 が使えない環境もあるので、IPv6 側の失敗は致命的に扱わない
      if (!primary) return;
      console.error(`${host}:${PORT} で待ち受けできませんでした: ${e.code || e.message}`);
      process.exit(1);
    });
}
