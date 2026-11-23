#!/usr/bin/env node
// Builds src/data/categories.json: Bybit spot base symbol -> main narrative,
// from CoinGecko categories (via nebula-core, run locally, not on Vercel).
//   node scripts/build-categories.mjs
// A token can be in several categories; its main one is the first in PRIORITY
// (most specific narrative first). Symbol matches keep the highest market cap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { coingecko } = await import(pathToFileURL('C:/Users/red1e/nebula-core/index.js').href);

// [CoinGecko category id, label], most specific first.
export const PRIORITY = [
  ['ai-agents', 'IA'], ['artificial-intelligence', 'IA'], ['depin', 'DePIN'], ['storage', 'DePIN'],
  ['meme-token', 'Meme'], ['oracle', 'Oracle'], ['real-world-assets-rwa', 'RWA'], ['gaming', 'Gaming'], ['privacy-coins', 'Privacy'],
  ['zero-knowledge-zk', 'ZK'], ['liquid-staking-tokens', 'Liquid staking'],
  ['decentralized-exchange', 'DeFi'], ['decentralized-finance-defi', 'DeFi'], ['exchange-based-tokens', 'Exchange'],
  ['layer-2', 'Layer 2'], ['layer-1', 'Layer 1'], ['infrastructure', 'Infrastructure'],
];

const best = {}; // symbol -> { mcap, cats: Set<label> }
for (const [id, label] of PRIORITY) {
  for (let page = 1; page <= 2; page++) {
    const list = await coingecko.marketsByCategory(id, page, 250);
    for (const c of list) {
      const b = (best[c.symbol] ||= { mcap: c.mcap || 0, cats: [] });
      if ((c.mcap || 0) >= b.mcap * 0.2) { if (!b.cats.includes(label)) b.cats.push(label); b.mcap = Math.max(b.mcap, c.mcap || 0); }
    }
    console.log(`${id} p${page}: ${list.length}`);
    if (list.length < 250) break;
  }
}
const out = Object.fromEntries(Object.entries(best).map(([s, b]) => [s, b.cats]).sort()); // ordered by PRIORITY: [0] = main
const file = path.join(HERE, '..', 'src', 'data', 'categories.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), source: 'CoinGecko categories', tokens: out })}\n`);
console.log(`${Object.keys(out).length} symbols -> ${file}`);
