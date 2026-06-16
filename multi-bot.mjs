// Multi-bot signal manager — scrapes public channels, broadcasts to all bots
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const BOTS_PATH = join(DATA, 'bot-tokens.json');
const SCRAPED_PATH = join(DATA, 'scraped-signals.json');

const USDT_ADDRESS = 'TCtQGdjjEcsnmWFkevrbiAWkJ9D9MCy8FS';
const SUB_PRICE = 30;
const SCRAPE_INTERVAL = 5 * 60 * 1000; // 5 min
const TRONGRID_API = 'https://api.trongrid.io';

// Public signal channels to scrape (via t.me/s/ web preview)
const SIGNAL_SOURCES = [
  // === VERIFIED WORKING (tested 2026-06-16) ===
  { id: 'WhaleCalls', url: 'https://t.me/s/WhaleCalls', type: 'whale' },
  { id: 'BinanceKillers', url: 'https://t.me/s/BinanceKillers', type: 'signals' },
  { id: 'cryptosignalsfree', url: 'https://t.me/s/cryptosignalsfree', type: 'signals' },
  { id: 'CryptoVIPSignalFree', url: 'https://t.me/s/CryptoVIPSignalFree', type: 'signals' },
  { id: 'whale_alert_io', url: 'https://t.me/s/whale_alert_io', type: 'whale' },
  { id: 'EveningTrader', url: 'https://t.me/s/EveningTrader', type: 'signals' },
  { id: 'WolfOfTrading', url: 'https://t.me/s/WolfOfTrading', type: 'signals' },
  { id: 'RavenSignalsPro', url: 'https://t.me/s/RavenSignalsPro', type: 'futures' },
  { id: 'sublimetraders', url: 'https://t.me/s/sublimetraders', type: 'signals' },
  { id: 'DeFiMillionaire', url: 'https://t.me/s/DeFiMillionaire', type: 'defi' },
  { id: 'fatpigsignals', url: 'https://t.me/s/fatpigsignals', type: 'signals' },
  { id: 'Learn2TradeCrypto', url: 'https://t.me/s/Learn2TradeCrypto', type: 'signals' },
];

// ============= DATA =============
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}
async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

// Human-friendly "Xm ago" — used in broadcast headers
function formatTimeAgo(ts) {
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 1000) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Initialize a subscriber record (idempotent — never clobbers premium fields)
function ensureUser(subs, chatId, username) {
  if (!subs.subscribers[chatId]) {
    subs.subscribers[chatId] = {
      username: username || 'unknown',
      plan: 'free',
      joinedAt: Date.now(),
      bonusSignals: 0,
      referrals: [],
    };
  } else {
    const rec = subs.subscribers[chatId];
    if (username && (!rec.username || rec.username === 'unknown')) rec.username = username;
    if (rec.bonusSignals == null) rec.bonusSignals = 0;
    if (!Array.isArray(rec.referrals)) rec.referrals = [];
  }
  return subs.subscribers[chatId];
}

// ============= SCRAPE PUBLIC CHANNELS =============
async function scrapeChannel(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();

    // Parse messages from t.me/s/ HTML
    const messages = [];
    const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const timeRegex = /<time[^>]*datetime="([^"]*)"[^>]*>/g;

    let match;
    const texts = [];
    while ((match = msgRegex.exec(html)) !== null) {
      // Strip HTML tags
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 20) texts.push(text);
    }

    // Extract timestamps
    const times = [];
    while ((match = timeRegex.exec(html)) !== null) {
      times.push(new Date(match[1]).getTime());
    }

    // Combine - take last 10 messages
    for (let i = Math.max(0, texts.length - 10); i < texts.length; i++) {
      messages.push({
        source: source.id,
        type: source.type,
        text: texts[i]?.slice(0, 1000),
        ts: times[i] || Date.now(),
      });
    }

    return messages;
  } catch (e) {
    console.error(`[scrape] ${source.id}: ${e.message}`);
    return [];
  }
}

// Parse signal from raw text — improved pair detection
function parseSignal(text) {
  const upper = text.toUpperCase();

  // Detect direction
  let direction = null;
  if (upper.includes('LONG') || upper.includes('BUY') || upper.includes('BULLISH') || upper.includes('🟢') || upper.includes('📈')) direction = 'LONG';
  if (upper.includes('SHORT') || upper.includes('SELL') || upper.includes('BEARISH') || upper.includes('🔴') || upper.includes('📉')) direction = 'SHORT';

  // Detect pair — multiple formats
  let pair = null;
  // Format: BTC/USDT, ETH/BTC etc
  const slash = upper.match(/\b([A-Z]{2,10})\s*[\/\\]\s*(USDT|USD|BTC|ETH|BUSD|USDC)\b/);
  if (slash) { pair = slash[1]+'/'+slash[2]; }
  // Format: BTCUSDT (concatenated)
  if (!pair) { const concat = upper.match(/\b(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|AVAX|LINK|MATIC|BNB|PEPE|WIF|BONK|ARB|OP|APT|SUI|SEI|TIA|JUP|WLD|FET|RNDR|INJ|NEAR)(USDT|USD|BTC|ETH|BUSD|USDC|PERP)\b/); if (concat) pair = concat[1]+'/'+concat[2]; }
  // Format: #BTC, $BTC, #ETH (hashtag/dollar)
  if (!pair) { const hash = upper.match(/[#$]\s*(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|AVAX|LINK|MATIC|BNB|PEPE|WIF|BONK|ARB|OP|APT|SUI|SEI|TIA|JUP|WLD|FET|RNDR|INJ|NEAR)\b/); if (hash) pair = hash[1]+'/USDT'; }
  // Format: standalone known coin names in context of signal
  if (!pair && direction) { const coin = upper.match(/\b(BITCOIN|ETHEREUM|SOLANA|RIPPLE|DOGECOIN)\b/); if (coin) { const map = {BITCOIN:'BTC',ETHEREUM:'ETH',SOLANA:'SOL',RIPPLE:'XRP',DOGECOIN:'DOGE'}; pair = (map[coin[1]]||coin[1])+'/USDT'; } }

  // Detect entry price — more patterns
  const entryPatterns = [
    /(?:entry|enter|price|buy|sell|ep)\s*[:=]\s*\$?([\d,.]+)/i,
    /(?:entry|price)\s+(?:zone|area|around)?\s*\$?([\d,.]+)/i,
    /(?:at|@)\s*\$?([\d,.]+)/i,
  ];
  let entry = null;
  for (const p of entryPatterns) { const m = text.match(p); if (m) { entry = m[1].replace(/,/g, ''); break; } }

  // Detect targets
  const tpMatches = [...text.matchAll(/(?:tp|target|take\s*profit|t\.p)\s*\d?\s*[:=\s]\s*\$?([\d,.]+)/gi)];
  const targets = tpMatches.map(m => m[1].replace(/,/g, '')).filter(Boolean);

  // Detect stop loss
  const slPatterns = [/(?:sl|stop\s*loss|stoploss|s\.l)\s*[:=\s]\s*\$?([\d,.]+)/i];
  let stopLoss = null;
  for (const p of slPatterns) { const m = text.match(p); if (m) { stopLoss = m[1].replace(/,/g, ''); break; } }

  // Detect leverage
  const levMatch = text.match(/(\d{1,3})\s*x\b/i) || text.match(/leverage\s*[:=]\s*(\d+)/i);
  const leverage = levMatch ? levMatch[1] : null;

  // Is this a signal?
  const isSignal = (direction || pair) && (entry || targets.length || stopLoss || text.length < 500);

  return { direction, pair, entry, targets, stopLoss, leverage, isSignal };
}

// ============= TELEGRAM =============
async function sendMsg(token, chatId, text, opts) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (opts && opts.reply_markup) body.reply_markup = opts.reply_markup;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

// Live crypto price via CoinGecko (free, no key). Returns USD number or null.
async function fetchLivePrice(pair) {
  // pair format: BTC/USDT -> coingecko id: bitcoin
  const coinMap = {
    'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'XRP': 'ripple',
    'DOGE': 'dogecoin', 'ADA': 'cardano', 'DOT': 'polkadot', 'AVAX': 'avalanche-2',
    'LINK': 'chainlink', 'MATIC': 'matic-network', 'BNB': 'binancecoin',
    'NEAR': 'near', 'ARB': 'arbitrum', 'OP': 'optimism', 'SUI': 'sui',
    'PEPE': 'pepe', 'WIF': 'dogwifcoin', 'JUP': 'jupiter-exchange-solana',
    'INJ': 'injective-protocol', 'FET': 'fetch-ai', 'RNDR': 'render-token'
  };
  const coin = pair?.split('/')[0]?.toUpperCase();
  const id = coinMap[coin];
  if (!id) return null;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data[id]?.usd || null;
  } catch { return null; }
}

// 60s in-memory cache keyed by base coin to keep CoinGecko free tier happy
const priceCache = {};
async function getCachedPrice(pair) {
  const key = pair?.split('/')[0]?.toUpperCase();
  if (!key) return null;
  const hit = priceCache[key];
  if (hit && Date.now() - hit.ts < 60_000) return hit.price;
  const price = await fetchLivePrice(pair);
  if (price) priceCache[key] = { price, ts: Date.now() };
  return price;
}

async function formatSignal(parsed, rawText, opts = {}) {
  if (!parsed.isSignal) return null;
  const dirEmoji = parsed.direction === 'LONG' ? '\u{1F7E2}' :
                   parsed.direction === 'SHORT' ? '\u{1F534}' : '\u{1F4CA}';
  const dirText = parsed.direction || 'SIGNAL';
  const pair = parsed.pair || 'CRYPTO';
  const divider = '\u2500'.repeat(20);

  // Header: optional #N tag + direction/pair + optional time-since
  const numTag = opts.signalNum ? `*#${opts.signalNum}* \u2022 ` : '';
  const ago = opts.sourceTs ? ` \u2022 _${formatTimeAgo(opts.sourceTs)}_` : '';
  let msg = `${numTag}${dirEmoji} *${dirText}* \u2022 *${pair}*${ago}\n${divider}\n`;
  if (parsed.entry) msg += `\u{1F4CD} Entry: \`$${parsed.entry}\`\n`;
  if (parsed.targets.length) {
    parsed.targets.forEach((t, i) => {
      msg += `\u{1F3AF} TP${i + 1}: \`$${t}\`\n`;
    });
  }
  if (parsed.stopLoss) msg += `\u{1F6D1} SL: \`$${parsed.stopLoss}\`\n`;
  if (parsed.leverage) msg += `\u26A1 Leverage: ${parsed.leverage}x\n`;

  // Risk/Reward: (target - entry) / (entry - stopLoss), abs check for sign sanity
  if (parsed.entry && parsed.targets[0] && parsed.stopLoss) {
    const e = parseFloat(parsed.entry);
    const t0 = parseFloat(parsed.targets[0]);
    const sl = parseFloat(parsed.stopLoss);
    if (Number.isFinite(e) && Number.isFinite(t0) && Number.isFinite(sl)) {
      const risk = Math.abs(e - sl);
      const reward = Math.abs(t0 - e);
      if (risk > 0) {
        const rr = (reward / risk).toFixed(1);
        msg += `\n\u{1F4CA} Risk/Reward: 1:${rr}\n`;
      }
    }
  }

  // Live price from CoinGecko (cached 60s, best-effort)
  if (parsed.pair) {
    const price = await getCachedPrice(parsed.pair);
    if (price) msg += `\n\u{1F4B5} Live: $${price.toLocaleString('en-US')}\n`;
  }

  msg += `\u23F0 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`;
  msg += `${divider}\n`;
  msg += `\u26A0\uFE0F _NFA. DYOR. Past \u2260 future._\n`;
  msg += `\u{1F514} /subscribe for all signals`;
  return msg;
}

// ============= DEXSCREENER NEW PAIRS SCANNER =============
async function scanDexScreenerNewPairs() {
  try {
    // Get recently boosted tokens (trending)
    const boostRes = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
      signal: AbortSignal.timeout(8000)
    });
    const boosts = await boostRes.json();

    // Filter Solana tokens with >$10K liquidity
    const solTokens = (boosts || []).filter(t =>
      t.chainId === 'solana' && t.url
    ).slice(0, 5);

    const results = [];
    for (const t of solTokens) {
      // Get pair details
      const tokenAddr = t.tokenAddress;
      if (!tokenAddr) continue;
      const detailRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`, {
        signal: AbortSignal.timeout(5000)
      });
      const detail = await detailRes.json();
      const pair = detail?.pairs?.[0];
      if (!pair) continue;

      const price = parseFloat(pair.priceUsd) || 0;
      const volume24h = parseFloat(pair.volume?.h24) || 0;
      const liquidity = parseFloat(pair.liquidity?.usd) || 0;
      const priceChange = parseFloat(pair.priceChange?.h24) || 0;
      const symbol = pair.baseToken?.symbol || '???';
      const name = pair.baseToken?.name || '';

      // Only interesting tokens: >$5K liquidity, >$1K volume
      if (liquidity < 5000 || volume24h < 1000) continue;

      results.push({
        symbol, name, price, volume24h, liquidity, priceChange,
        address: tokenAddr,
        dexUrl: pair.url || `https://dexscreener.com/solana/${tokenAddr}`,
        pairAddress: pair.pairAddress,
      });
    }
    return results;
  } catch (e) {
    console.error('[dexscreener]', e.message);
    return [];
  }
}

// ============= PUMP.FUN REAL-TIME NEW TOKEN MONITOR =============
// PumpPortal WebSocket — free, no auth, real-time new token launches
let pumpWsConnected = false;
function startPumpFunMonitor(signalBots, adminBot, cfg) {
  const WS_URL = 'wss://pumpportal.fun/api/data';
  let ws = null;
  let reconnectTimer = null;
  const seenMints = new Set();

  function connect() {
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      // WebSocket not available in older Node — use fetch polling fallback
      console.log('[pump.fun] WebSocket not available, using REST fallback');
      startPumpFunPolling(signalBots, adminBot, cfg);
      return;
    }

    ws.on('open', () => {
      pumpWsConnected = true;
      console.log('[pump.fun] WebSocket connected');
      // Subscribe to new token creations
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (!event.mint || seenMints.has(event.mint)) return;
        seenMints.add(event.mint);

        const symbol = event.symbol || event.name?.slice(0, 10) || '???';
        const name = event.name || '';
        const mcapSol = event.marketCapSol || 0;
        const uri = event.uri || '';

        // Filter: only tokens with some initial buy (not pure spam)
        if (!event.initialBuy && mcapSol < 0.5) return;

        // Check safety (quick, non-blocking)
        const safety = await checkTokenSafety(event.mint, 'solana').catch(() => ({safe: null, score: 0, risks: []}));

        const safeEmoji = safety.safe === true ? '\u2705' : safety.safe === false ? '\u26A0\uFE0F' : '\u2753';
        const msg =
          `\u{1F680} *NEW TOKEN LAUNCH*\n` +
          `\u2500`.repeat(20) + `\n` +
          `\u{1F4B0} *${symbol}* (${name.slice(0, 30)})\n` +
          `\u{1F30D} Pump.fun | Solana\n` +
          `\u{1F4CA} Initial mcap: ${mcapSol.toFixed(1)} SOL\n` +
          `${safeEmoji} Safety: ${safety.score}/1000\n` +
          `\u{1F517} [Pump.fun](https://pump.fun/${event.mint})\n` +
          `\u{1F517} [DexScreener](https://dexscreener.com/solana/${event.mint})\n` +
          `\u2500`.repeat(20) + `\n` +
          `\u26A0\uFE0F _Extremely high risk. DYOR. NFA._\n` +
          `\u{1F514} /subscribe for all alerts`;

        // Broadcast to premium only (new launches are premium feature)
        await broadcastSignal(signalBots, msg);
        await sendMsg(adminBot.token, cfg.telegramChatId,
          `\u{1F680} PUMP.FUN: ${symbol} mcap:${mcapSol.toFixed(1)}SOL safe:${safety.score}`);
        console.log(`[pump.fun] ${symbol} mcap:${mcapSol.toFixed(1)}SOL`);

        // Trim seen set
        if (seenMints.size > 2000) {
          const arr = [...seenMints]; arr.splice(0, arr.length - 1000);
          seenMints.clear(); arr.forEach(a => seenMints.add(a));
        }
      } catch (e) {
        if (Math.random() < 0.05) console.error('[pump.fun] msg error:', e.message);
      }
    });

    ws.on('close', () => {
      pumpWsConnected = false;
      console.log('[pump.fun] WebSocket disconnected, reconnecting in 10s...');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 10000);
    });

    ws.on('error', (err) => {
      console.error('[pump.fun] WS error:', err.message);
      try { ws.close(); } catch {}
    });
  }

  connect();
}

// REST fallback for environments without WebSocket
async function startPumpFunPolling(signalBots, adminBot, cfg) {
  const seenMints = new Set();
  setInterval(async () => {
    try {
      // Use DexScreener latest Solana pairs as proxy for pump.fun new tokens
      const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=pump.fun', {
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      const pairs = (data.pairs || []).filter(p =>
        p.chainId === 'solana' && p.pairCreatedAt && Date.now() - p.pairCreatedAt < 600000 // last 10 min
      ).slice(0, 3);

      for (const p of pairs) {
        if (seenMints.has(p.baseToken?.address)) continue;
        seenMints.add(p.baseToken?.address);
        const symbol = p.baseToken?.symbol || '???';
        const liq = parseFloat(p.liquidity?.usd) || 0;
        if (liq < 2000) continue;

        const msg = `\u{1F680} *New Solana Token*\n${symbol} | Liq: $${(liq/1000).toFixed(1)}K\n${p.url || ''}`;
        await broadcastSignal(signalBots, msg);
        console.log(`[pump.fun/rest] ${symbol} liq:$${(liq/1000).toFixed(0)}K`);
      }
      if (seenMints.size > 1000) { const a=[...seenMints]; a.splice(0,500); seenMints.clear(); a.forEach(x=>seenMints.add(x)); }
    } catch {}
  }, 5 * 60 * 1000);
  console.log('[pump.fun] REST fallback: polling every 5 min');
}

// ============= TOKEN SAFETY CHECK =============
async function checkTokenSafety(address, chain = 'solana') {
  try {
    if (chain === 'solana') {
      // RugCheck for Solana
      const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      return {
        safe: data.score >= 500, // rugcheck score: higher = safer
        score: data.score || 0,
        risks: data.risks?.map(r => r.name)?.slice(0, 3) || [],
        source: 'rugcheck'
      };
    }
    // GoPlus for EVM chains
    const chainId = chain === 'ethereum' ? '1' : chain === 'bsc' ? '56' : '1';
    const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    const info = data.result?.[address.toLowerCase()];
    if (!info) return { safe: null, score: 0, risks: ['unknown'], source: 'goplus' };
    const isHoneypot = info.is_honeypot === '1';
    const isOpenSource = info.is_open_source === '1';
    const canSell = info.cannot_sell_all !== '1';
    return {
      safe: !isHoneypot && canSell,
      score: isHoneypot ? 0 : (isOpenSource ? 800 : 400),
      risks: [
        isHoneypot && 'honeypot',
        !canSell && 'cannot-sell',
        !isOpenSource && 'closed-source'
      ].filter(Boolean),
      source: 'goplus'
    };
  } catch { return { safe: null, score: 0, risks: ['check-failed'], source: 'error' }; }
}

// ============= MULTI-BOT BROADCAST =============
async function broadcastSignal(bots, signalText) {
  for (const [username, bot] of Object.entries(bots)) {
    // Load subscribers for this bot
    const subsPath = join(DATA, `subs-${username}.json`);
    const subs = await loadJson(subsPath, { subscribers: {} });

    let sent = 0;
    for (const [chatId, sub] of Object.entries(subs.subscribers)) {
      if (sub.plan === 'premium' && sub.expiresAt > Date.now()) {
        await sendMsg(bot.token, chatId, signalText);
        sent++;
        if (sent % 20 === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.log(`  @${username}: sent to ${sent} premium users`);
  }
}

// ============= SCRAPE + BROADCAST LOOP =============
async function scrapeAndBroadcast(bots, cfg) {
  const scraped = await loadJson(SCRAPED_PATH, { lastIds: {}, signals: [], totalCount: 0 });
  if (typeof scraped.totalCount !== 'number') scraped.totalCount = scraped.signals?.length || 0;
  let newSignals = 0;

  for (const source of SIGNAL_SOURCES) {
    const messages = await scrapeChannel(source);
    for (const msg of messages) {
      // Deduplicate by text hash
      const hash = msg.text.slice(0, 50);
      if (scraped.lastIds[hash]) continue;
      scraped.lastIds[hash] = msg.ts;

      // Parse signal
      const parsed = parseSignal(msg.text);
      if (!parsed.isSignal) continue;

      scraped.totalCount += 1;
      const signalNum = scraped.totalCount;
      const formatted = await formatSignal(parsed, msg.text, { signalNum, sourceTs: msg.ts });
      if (!formatted) continue;

      const taggedMsg = formatted + `\n\n_Source: ${source.id}_`;

      // Broadcast to all bots
      console.log(`[signal] ${parsed.direction || '?'} ${parsed.pair || '?'} from ${source.id}`);
      await broadcastSignal(bots, taggedMsg);

      // Also notify owner
      await sendMsg(cfg.telegramToken, cfg.telegramChatId,
        `\u{1F4E1} Signal scraped from ${source.id}:\n${taggedMsg}`);

      scraped.signals.push({ ...parsed, source: source.id, ts: Date.now(), num: signalNum });
      newSignals++;
    }
  }

  // Keep last 500 signals, trim old hashes
  if (scraped.signals.length > 500) scraped.signals = scraped.signals.slice(-500);
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(scraped.lastIds)) {
    if (v < cutoff) delete scraped.lastIds[k];
  }

  await saveJson(SCRAPED_PATH, scraped);
  return newSignals;
}

// ============= SETUP EACH BOT =============
async function setupBot(username, bot) {
  // Set commands
  await fetch(`https://api.telegram.org/bot${bot.token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Info & pricing' },
        { command: 'signals', description: 'Latest signals' },
        { command: 'free', description: 'Free signal (1/24h)' },
        { command: 'subscribe', description: `Premium $${SUB_PRICE}/msc` },
        { command: 'paid', description: 'Confirm payment' },
        { command: 'status', description: 'Check subscription' },
        { command: 'performance', description: 'Stats & breakdown' },
        { command: 'pnl', description: 'Signal P&L history' },
        { command: 'referral', description: 'Your invite link & bonuses' },
        { command: 'help', description: 'How to use this bot' },
      ]
    })
  });

  // Set description
  const descriptions = {
    solana: 'Solana Sniper Signals \u2014 real-time SOL memecoin alerts, whale moves, new launches. Premium: $30/msc USDT.',
    btc_eth: 'Crypto Signals PRO \u2014 BTC/ETH/Altcoin signals, 92%+ accuracy. Spot & Futures. Premium: $30/msc USDT.',
    general: 'Crypto Signal Bot \u2014 multi-source aggregated signals. Premium: $30/msc USDT.',
  };

  await fetch(`https://api.telegram.org/bot${bot.token}/setMyDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: descriptions[bot.niche] || descriptions.general })
  });

  console.log(`[setup] @${username} (${bot.niche}) configured`);
}

// ============= ADMIN BOT (jarkens_bot — owner only) =============
async function handleAdminMessage(adminToken, msg, cfg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const isOwner = chatId === String(cfg.telegramChatId);
  if (!isOwner) {
    await sendMsg(adminToken, chatId, '\u{1F512} Private admin bot. Access denied.');
    return;
  }
  if (text === '/start') {
    await sendMsg(adminToken, chatId,
      '\u{1F6E1}\uFE0F *Admin Panel*\n\n/revenue \u2014 earnings\n/bots \u2014 bot status\n/subs \u2014 subscribers\n/users \u2014 unique users\n/scraped \u2014 recent signals\n/signal LONG BTC/USDT 65000 TP:67000 SL:63000 \u2014 manual signal\n/broadcast Msg \u2014 send to all');
  } else if (text === '/bots') {
    const bd = await loadJson(BOTS_PATH, {}); let resp = '\u{1F916} *Bots:*\n';
    for (const [u,b] of Object.entries(bd.signal_bots||{})) {
      const r = await fetch('https://api.telegram.org/bot'+b.token+'/getMe').then(r=>r.json()).catch(()=>({ok:false}));
      resp += `\u2022 @${u} (${b.niche}) ${r.ok?'\u2705':'\u274C'}\n`;
    } await sendMsg(adminToken, chatId, resp);
  } else if (text === '/subs') {
    const bd = await loadJson(BOTS_PATH, {}); let resp = '\u{1F4CA} *Subs:*\n', tot = 0;
    for (const u of Object.keys(bd.signal_bots||{})) {
      const s = await loadJson(join(DATA,`subs-${u}.json`),{subscribers:{}});
      const a = Object.values(s.subscribers).filter(x=>x.plan==='premium'&&x.expiresAt>Date.now()).length;
      resp += `\u2022 @${u}: ${a} premium\n`; tot += a;
    } resp += `\n\u{1F4B0} MRR: $${tot*SUB_PRICE}`;
    await sendMsg(adminToken, chatId, resp);
  } else if (text === '/users') {
    const bd = await loadJson(BOTS_PATH, {});
    const unique = new Set();
    let resp = '\u{1F465} *Users (all bots)*\n';
    for (const u of Object.keys(bd.signal_bots||{})) {
      const s = await loadJson(join(DATA,`subs-${u}.json`),{subscribers:{}});
      const ids = Object.keys(s.subscribers||{});
      const prem = ids.filter(id => s.subscribers[id].plan === 'premium' && s.subscribers[id].expiresAt > Date.now()).length;
      for (const id of ids) unique.add(id);
      resp += `\u2022 @${u}: ${ids.length} total / ${prem} premium\n`;
    }
    resp += `\n\u{1F3AF} *Total unique:* ${unique.size}`;
    await sendMsg(adminToken, chatId, resp);
  } else if (text === '/scraped') {
    const sc = await loadJson(SCRAPED_PATH,{signals:[]}); let resp = '\u{1F4E1} *Last 5:*\n';
    for (const s of sc.signals.slice(-5)) resp += `${s.direction==='LONG'?'\u{1F7E2}':'\u{1F534}'} ${s.pair||'?'} from ${s.source||'?'}\n`;
    await sendMsg(adminToken, chatId, resp);
  } else if (text === '/dex') {
    const tokens = await scanDexScreenerNewPairs();
    let resp = '\u{1F4A1} *DexScreener Trending:*\n';
    if (!tokens.length) { resp += 'No interesting tokens right now.'; }
    else {
      for (const t of tokens.slice(0, 5)) {
        const safety = await checkTokenSafety(t.address, 'solana');
        resp += `\n${t.symbol} $${t.price < 0.01 ? t.price.toExponential(2) : t.price.toFixed(4)} vol:$${(t.volume24h/1000).toFixed(0)}K liq:$${(t.liquidity/1000).toFixed(0)}K safe:${safety.score}/1000`;
      }
    }
    await sendMsg(adminToken, chatId, resp);
  } else if (text === '/revenue') {
    const bd = await loadJson(BOTS_PATH, {}); let rev = 0, act = 0;
    for (const u of Object.keys(bd.signal_bots||{})) {
      const s = await loadJson(join(DATA,`subs-${u}.json`),{subscribers:{},stats:{revenue:0}});
      rev += s.stats?.revenue||0; act += Object.values(s.subscribers).filter(x=>x.plan==='premium'&&x.expiresAt>Date.now()).length;
    }
    await sendMsg(adminToken, chatId, `\u{1F4B0} *Revenue*\nTotal: $${rev}\nActive: ${act}\nMRR: $${act*SUB_PRICE}\nWallet: \`${USDT_ADDRESS}\``);
  } else if (text.startsWith('/signal ')) {
    const parts = text.slice(8).split(' '); const dir = parts[0]?.toUpperCase(); const pair = parts[1]; const entry = parts[2];
    let targets=[],sl=null,lev=null,notes='';
    for (const p of parts.slice(3)) { if(p.startsWith('TP:'))targets=p.slice(3).split(','); else if(p.startsWith('SL:'))sl=p.slice(3); else if(p.startsWith('LEV:'))lev=p.slice(4); else notes+=p+' '; }
    const sig = {direction:dir,pair,entry,targets,stopLoss:sl,leverage:lev,notes:notes.trim(),source:'manual',isSignal:true};
    const sc = await loadJson(SCRAPED_PATH, { lastIds:{}, signals:[], totalCount:0 });
    sc.totalCount = (sc.totalCount || sc.signals?.length || 0) + 1;
    const sigNum = sc.totalCount;
    const now = Date.now();
    const fmt = await formatSignal(sig, '', { signalNum: sigNum, sourceTs: now });
    if (fmt) {
      const bd = await loadJson(BOTS_PATH, {});
      const tagged = fmt + `\n\n_Source: manual_`;
      await broadcastSignal(bd.signal_bots || {}, tagged);
      sc.signals = sc.signals || [];
      sc.signals.push({ ...sig, source: 'manual', ts: now, num: sigNum });
      if (sc.signals.length > 500) sc.signals = sc.signals.slice(-500);
      await saveJson(SCRAPED_PATH, sc);
      await sendMsg(adminToken, chatId, `\u2705 Broadcast done (#${sigNum})`);
    }
  } else if (text.startsWith('/broadcast ')) {
    const t = text.slice(11); const bd = await loadJson(BOTS_PATH,{}); let n=0;
    for (const [u,b] of Object.entries(bd.signal_bots||{})) {
      const s = await loadJson(join(DATA,`subs-${u}.json`),{subscribers:{}});
      for (const cid of Object.keys(s.subscribers)) { await sendMsg(b.token,cid,t); n++; }
    } await sendMsg(adminToken,chatId,`\u{1F4E2} Sent to ${n} users`);
  }
}

// ============= MAIN =============
async function main() {
  const cfg = await loadJson(join(ROOT, 'config.json'), {});
  const botData = await loadJson(BOTS_PATH, {});
  const adminBot = botData.admin;
  const signalBots = botData.signal_bots || {};

  console.log(`[multi-bot] Admin: @${adminBot.username} (owner only)`);
  console.log(`[multi-bot] Signal bots: ${Object.keys(signalBots).join(', ')}`);
  console.log(`[multi-bot] Sources: ${SIGNAL_SOURCES.length}`);

  // Ensure subscriber files exist for every signal bot (idempotent)
  for (const u of Object.keys(signalBots)) {
    const p = join(DATA, `subs-${u}.json`);
    try { await readFile(p); }
    catch { await saveJson(p, { subscribers: {}, pendingPayments: {}, stats: { revenue: 0 } }); console.log(`[init] created ${p}`); }
  }

  for (const [u,b] of Object.entries(signalBots)) await setupBot(u,b);

  // Admin bot: private commands only
  await fetch(`https://api.telegram.org/bot${adminBot.token}/setMyCommands`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({commands:[
      {command:'start',description:'Admin panel'},{command:'revenue',description:'Earnings'},
      {command:'bots',description:'Bot status'},{command:'subs',description:'Subscribers'},
      {command:'users',description:'Unique users (all bots)'},
      {command:'scraped',description:'Recent signals'}
    ]})
  });
  await fetch(`https://api.telegram.org/bot${adminBot.token}/setMyDescription`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({description:'Private admin panel. Not a public bot.'})
  });

  // TRON payment checking — co 60s sprawdz blockchain dla KAZDEGO bota
  const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const SUB_DAYS = 30;
  setInterval(async () => {
    try {
      const res = await fetch(`${TRONGRID_API}/v1/accounts/${USDT_ADDRESS}/transactions/trc20?limit=20&contract_address=${USDT_CONTRACT}`,
        {headers: {'Accept': 'application/json'}, signal: AbortSignal.timeout(10000)});
      const txData = await res.json();
      const txs = txData?.data || [];

      for (const [botUser, bot] of Object.entries(signalBots)) {
        const subsPath = join(DATA, `subs-${botUser}.json`);
        const subs = await loadJson(subsPath, {subscribers:{}, pendingPayments:{}, stats:{revenue:0}});
        let changed = false;

        for (const tx of txs) {
          if (tx.to !== USDT_ADDRESS) continue;
          const amount = Number(tx.value) / 1e6;
          if (amount < SUB_PRICE * 0.95) continue;
          const txHash = tx.transaction_id;
          if (Object.values(subs.subscribers).some(s => s.txHash === txHash)) continue;

          const pending = Object.entries(subs.pendingPayments).filter(([_,p]) => !p.confirmed).sort((a,b) => a[1].ts - b[1].ts);
          if (pending.length > 0) {
            const [chatId, pend] = pending[0];
            const expiresAt = Date.now() + SUB_DAYS * 24 * 3600 * 1000;
            subs.subscribers[chatId] = {username: pend.username||'unknown', plan:'premium', expiresAt, txHash, paidAt: Date.now(), amount};
            subs.pendingPayments[chatId].confirmed = true;
            subs.stats.revenue = (subs.stats.revenue||0) + amount;
            changed = true;

            const expDate = new Date(expiresAt).toISOString().slice(0,10);
            await sendMsg(bot.token, chatId, `\u2705 *Payment confirmed!*\n\nAmount: ${amount} USDT\nPlan: Premium (${SUB_DAYS} days)\nExpires: ${expDate}\n\nYou now have access to ALL signals. Use /signals`);
            await sendMsg(adminBot.token, cfg.telegramChatId, `\u{1F4B0} PAYMENT! $${amount} USDT\n@${botUser} \u2190 @${pend.username||chatId}\nTx: ${txHash.slice(0,16)}...`);
            console.log(`[payment] $${amount} from ${chatId} on @${botUser}`);
          }
        }

        // Check expired subs
        for (const [chatId, sub] of Object.entries(subs.subscribers)) {
          if (sub.plan === 'premium' && sub.expiresAt < Date.now()) {
            sub.plan = 'expired'; changed = true;
            await sendMsg(bot.token, chatId, `\u23F0 Your subscription expired.\n\n/subscribe to renew ($${SUB_PRICE} USDT/msc)`);
          }
        }
        if (changed) await saveJson(subsPath, subs);
      }
    } catch (e) {
      if (Math.random() < 0.02) console.error('[tron]', e.message);
    }
  }, 60_000);
  console.log(`[multi-bot] TRON payment checking: ON (every 60s)`);

  const initial = await scrapeAndBroadcast(signalBots, cfg);
  console.log(`[multi-bot] Initial scrape: ${initial} new signals`);

  setInterval(async () => {
    try {
      const n = await scrapeAndBroadcast(signalBots, cfg);
      if (n > 0) console.log(`[multi-bot] Scraped ${n} new signals`);
    } catch (e) {
      console.error('[scrape] error:', e.message);
    }
  }, SCRAPE_INTERVAL);

  // DexScreener new pairs scan every 10 min
  const dexSeenTokens = new Set();
  setInterval(async () => {
    try {
      const tokens = await scanDexScreenerNewPairs();
      for (const t of tokens) {
        if (dexSeenTokens.has(t.address)) continue;
        dexSeenTokens.add(t.address);

        // Check safety
        const safety = await checkTokenSafety(t.address, 'solana');

        const safeEmoji = safety.safe === true ? '\u2705' : safety.safe === false ? '\u26A0\uFE0F' : '\u2753';
        const changeEmoji = t.priceChange >= 0 ? '\u{1F7E2}' : '\u{1F534}';

        const msg = `\u{1F4A1} *New Token Alert*\n` +
          `\u2500`.repeat(20) + `\n` +
          `\u{1F4B0} *${t.symbol}* (${t.name})\n` +
          `\u{1F4B5} Price: $${t.price < 0.01 ? t.price.toExponential(2) : t.price.toFixed(4)}\n` +
          `${changeEmoji} 24h: ${t.priceChange >= 0 ? '+' : ''}${t.priceChange.toFixed(1)}%\n` +
          `\u{1F4CA} Vol: $${(t.volume24h/1000).toFixed(1)}K | Liq: $${(t.liquidity/1000).toFixed(1)}K\n` +
          `${safeEmoji} Safety: ${safety.score}/1000${safety.risks.length ? ' (' + safety.risks.join(', ') + ')' : ''}\n` +
          `\u{1F517} [DexScreener](${t.dexUrl})\n` +
          `\u2500`.repeat(20) + `\n` +
          `\u26A0\uFE0F _NFA. Always DYOR before trading._\n` +
          `\u{1F514} /subscribe for all alerts`;

        await broadcastSignal(signalBots, msg);
        await sendMsg(adminBot.token, cfg.telegramChatId, `\u{1F4A1} DexScreener: ${t.symbol} $${t.price} vol:$${(t.volume24h/1000).toFixed(0)}K safe:${safety.score}`);
        console.log(`[dex] ${t.symbol} $${t.price} vol:$${(t.volume24h/1000).toFixed(0)}K safe:${safety.score}`);
      }
      // Trim seen set to prevent memory leak
      if (dexSeenTokens.size > 1000) {
        const arr = [...dexSeenTokens];
        arr.splice(0, arr.length - 500);
        dexSeenTokens.clear();
        arr.forEach(a => dexSeenTokens.add(a));
      }
    } catch (e) {
      console.error('[dex] scan error:', e.message);
    }
  }, 10 * 60 * 1000); // 10 min
  console.log('[multi-bot] DexScreener scanner: ON (every 10 min)');

  // Pump.fun real-time new token monitor
  try {
    // Check if WebSocket is available (Node 21+)
    const { WebSocket: WS } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    if (WS || globalThis.WebSocket) {
      if (!globalThis.WebSocket && WS) globalThis.WebSocket = WS;
      startPumpFunMonitor(signalBots, adminBot, cfg);
    } else {
      startPumpFunPolling(signalBots, adminBot, cfg);
    }
  } catch {
    // No WebSocket available — use REST fallback
    startPumpFunPolling(signalBots, adminBot, cfg);
  }

  // Auto video generation - once per day at 12:00 UTC
  function scheduleDaily(fn, hour = 12) {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      fn();
      setInterval(fn, 24 * 3600 * 1000);
    }, delay);
    console.log(`[video] Scheduled daily at ${hour}:00 UTC (in ${Math.round(delay/3600000)}h)`);
  }

  scheduleDaily(async () => {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const py = 'C:/Users/PC/AppData/Local/Microsoft/WindowsApps/python.exe';
      const { stdout } = await exec(py, [join(ROOT, 'video-pipeline.py')], { timeout: 120000 });
      console.log('[video]', stdout.trim());
      // Notify admin
      await sendMsg(adminBot.token, cfg.telegramChatId, '\u{1F3AC} Daily video generated!\n' + stdout.trim().slice(0, 200));
    } catch (e) {
      console.error('[video] daily generation failed:', e.message);
    }
  }, 12);

  // Watchdog: catch unhandled errors and keep the bot running
  process.on('uncaughtException', (err) => {
    console.error('[WATCHDOG] Uncaught:', err.message);
    // Do not exit - keep the bot running
  });
  process.on('unhandledRejection', (err) => {
    console.error('[WATCHDOG] Rejection:', err?.message || err);
  });

  console.log(`[multi-bot] Polling...`);
  const offsets = {};
  while (true) {
    for (const [username, bot] of Object.entries(signalBots)) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offsets[username]||0}&timeout=2&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,{signal:AbortSignal.timeout(5000)});
        const data = await res.json();
        for (const u of (data.result||[])) {
          offsets[username] = u.update_id + 1;
          if (u.message) await handleBotMessage(username, bot, u.message, cfg);
          else if (u.callback_query) {
            const cb = u.callback_query; const cId = String(cb.message.chat.id);
            await fetch(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:cb.id})});
            await handleBotMessage(username, bot, {chat:{id:cId}, from:cb.from, text:'/'+cb.data}, cfg);
          }
        }
      } catch {}
    }
    // Poll admin bot
    try {
      const res = await fetch(`https://api.telegram.org/bot${adminBot.token}/getUpdates?offset=${offsets.admin||0}&timeout=1&allowed_updates=${encodeURIComponent('["message"]')}`,{signal:AbortSignal.timeout(3000)});
      const data = await res.json();
      for (const u of (data.result||[])) { offsets.admin = u.update_id+1; if(u.message) await handleAdminMessage(adminBot.token,u.message,cfg); }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}

// Handle user messages on any bot
async function handleBotMessage(botUsername, bot, msg, cfg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const from = msg.from || {};
  const isOwner = chatId === String(cfg.telegramChatId);
  const subsPath = join(DATA, `subs-${botUsername}.json`);
  const subs = await loadJson(subsPath, { subscribers: {}, pendingPayments: {}, stats: { revenue: 0 } });

  const nicheNames = { solana: 'Solana Sniper', btc_eth: 'Crypto PRO', general: 'Signal Bot' };
  const niche = nicheNames[bot.niche] || 'Signal Bot';
  const ONE_DAY = 24 * 3600 * 1000;

  // /start (optionally with ref_USERID deep-link param)
  if (text === '/start' || text.startsWith('/start ')) {
    const wasNew = !subs.subscribers[chatId];
    const rec = ensureUser(subs, chatId, from.username);

    // Referral capture — only on first /start, and only if referrer differs
    const refMatch = text.match(/^\/start\s+ref_(\w+)/);
    if (refMatch && wasNew) {
      const referrerId = refMatch[1];
      if (referrerId !== chatId) {
        rec.referredBy = referrerId;
        // Make sure referrer has a record even if they pre-date the upgrade
        const refRec = ensureUser(subs, referrerId, null);
        if (!refRec.referrals.includes(chatId)) {
          refRec.referrals.push(chatId);
          refRec.bonusSignals = (refRec.bonusSignals || 0) + 3;
          // Notify referrer (fire-and-forget — failure must not block /start)
          sendMsg(bot.token, referrerId,
            `\u{1F389} *New referral!*\n@${from.username || 'someone'} joined via your link.\n\n` +
            `\u{1F381} +3 bonus signal views (total: *${refRec.bonusSignals}*)\n` +
            `Use them anytime with /free.`).catch(() => {});
        }
      }
    }
    await saveJson(subsPath, subs);

    const startKb = {
      inline_keyboard: [
        [{ text: '\u{1F4CA} Signals', callback_data: 'signals' }, { text: '\u{1F48E} Premium', callback_data: 'subscribe' }],
        [{ text: '\u{1F381} Free signal', callback_data: 'free' }, { text: '\u{1F517} Invite', callback_data: 'referral' }],
        [{ text: '\u{1F4C8} Performance', callback_data: 'perf' }, { text: '\u2753 Help', callback_data: 'help' }],
      ],
    };
    await sendMsg(bot.token, chatId,
      `\u{1F680} *${niche}*\n\nAggregated signals from top analysts.\n\n` +
      `\u{1F4CA} Free: 1 signal preview\n\u{1F48E} Premium: ALL signals + whale alerts\n\n` +
      `\u{1F4B0} Price: *$${SUB_PRICE} USDT/msc*\n\n` +
      `Tap a button below or send /help`,
      { reply_markup: startKb });

    if (wasNew) {
      if (!isOwner) {
        await sendMsg(cfg.telegramToken, cfg.telegramChatId,
          `\u{1F464} @${botUsername}: new user @${from.username || 'anon'} (${chatId})`);
      }
      // Delayed sample-signal pitch — non-blocking, swallows errors
      setTimeout(() => {
        sendMsg(bot.token, chatId,
          `\u{1F381} Want a sample signal? Type /free to get one now \u2014 no payment needed.`).catch(() => {});
      }, 5000);
    }
  } else if (text === '/referral') {
    ensureUser(subs, chatId, from.username);
    await saveJson(subsPath, subs);
    const rec = subs.subscribers[chatId];
    const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const refCount = rec.referrals.length;
    const bonus = rec.bonusSignals || 0;
    await sendMsg(bot.token, chatId,
      `\u{1F517} *Your referral link*\n\n\`${link}\`\n\n` +
      `\u{1F465} You referred: *${refCount}* user${refCount === 1 ? '' : 's'}\n` +
      `\u{1F381} Bonus signals: *${bonus}*\n\n` +
      `Each friend who taps your link = *+3 bonus signal views* (use via /free).\n` +
      `Share it anywhere \u2014 Twitter, Discord, group chats.`);
  } else if (text === '/pnl') {
    const scraped = await loadJson(SCRAPED_PATH, { signals: [] });
    const withTargets = (scraped.signals || []).filter(s => s.entry && s.targets && s.targets.length);
    const last10 = withTargets.slice(-10);
    const divider = '\u2500'.repeat(20);
    let resp = `\u{1F4CA} *Signal P&L \u2014 last ${last10.length}*\n${divider}\n`;
    if (!last10.length) {
      resp += `_No signals with full entry+targets yet. Check back soon._\n`;
    } else {
      let wins = 0, totalPct = 0, counted = 0;
      for (const s of last10) {
        const entry = parseFloat(s.entry);
        const target = parseFloat(s.targets[0]);
        if (!Number.isFinite(entry) || !Number.isFinite(target) || entry === 0) continue;
        const isLong = s.direction === 'LONG';
        // Theoretical: LONG profits when target > entry, SHORT when target < entry
        const pct = isLong
          ? ((target - entry) / entry) * 100
          : ((entry - target) / entry) * 100;
        const dirEmo = isLong ? '\u{1F7E2}' : s.direction === 'SHORT' ? '\u{1F534}' : '\u{1F4CA}';
        const sign = pct >= 0 ? '+' : '';
        // Display mark: treat first target as "reached" per spec
        const mark = pct >= 0 ? '\u2705' : '\u274C';
        const tag = s.num ? `#${s.num} ` : '';
        resp += `${dirEmo} ${tag}${s.direction || 'SIG'} ${s.pair || '?'} \`$${s.entry}\` \u2192 \`$${s.targets[0]}\` ${sign}${pct.toFixed(1)}% ${mark}\n`;
        if (pct >= 0) wins++;
        totalPct += pct;
        counted++;
      }
      if (counted > 0) {
        const winRate = ((wins / counted) * 100).toFixed(0);
        const avg = (totalPct / counted).toFixed(2);
        resp += `\n*Win rate:* ${winRate}% \u2022 *Avg:* ${avg}%\n`;
      }
    }
    resp += `\n\u26A0\uFE0F _Theoretical results based on first TP. Not financial advice._`;
    await sendMsg(bot.token, chatId, resp);
  } else if (text === '/free') {
    const rec = ensureUser(subs, chatId, from.username);
    const isPrem = rec.plan === 'premium' && rec.expiresAt > Date.now();
    if (isPrem) {
      await sendMsg(bot.token, chatId, '\u{1F48E} You already have Premium \u2014 every signal lands automatically. Try /signals or /pnl.');
      return;
    }
    const now = Date.now();
    const last = rec.lastFreeSignal || 0;
    const cooldownActive = (now - last) < ONE_DAY;
    const bonus = rec.bonusSignals || 0;

    if (cooldownActive && bonus <= 0) {
      const hoursLeft = Math.max(1, Math.ceil((ONE_DAY - (now - last)) / 3600000));
      await sendMsg(bot.token, chatId,
        `\u23F3 You already got your free signal today. /subscribe for unlimited.\n\n` +
        `_Next free signal in ~${hoursLeft}h._\n` +
        `Tip: invite a friend with /referral to earn bonus views.`);
      return;
    }

    const scraped = await loadJson(SCRAPED_PATH, { signals: [] });
    const latest = (scraped.signals || []).slice(-1)[0];
    if (!latest) {
      await sendMsg(bot.token, chatId, '\u{1F4ED} No signals scraped yet \u2014 nothing to hand out. Try again in a few minutes.');
      return;
    }
    const fmt = await formatSignal(latest, '', { signalNum: latest.num, sourceTs: latest.ts });
    if (!fmt) {
      await sendMsg(bot.token, chatId, '\u{1F4ED} Latest signal could not be formatted. Try again later.');
      return;
    }
    // Consume: prefer bonus while in cooldown, otherwise mark the daily slot used
    if (cooldownActive && bonus > 0) {
      rec.bonusSignals = bonus - 1;
    } else {
      rec.lastFreeSignal = now;
    }
    await saveJson(subsPath, subs);
    const header = (cooldownActive && bonus > 0)
      ? `\u{1F381} *Bonus signal* (${rec.bonusSignals} bonus left)`
      : `\u{1F381} *Your free signal of the day*`;
    await sendMsg(bot.token, chatId, `${header}\n\n${fmt}\n\n_Source: ${latest.source || 'aggregated'}_`);
  } else if (text === '/subscribe') {
    ensureUser(subs, chatId, from.username);
    await sendMsg(bot.token, chatId,
      `\u{1F48E} *Premium \u2014 $${SUB_PRICE}/msc*\n\n` +
      `Send *${SUB_PRICE} USDT (TRC-20)* to:\n\n\`${USDT_ADDRESS}\`\n\n` +
      `\u26A0\uFE0F Network: *TRC-20 (TRON)* only!\n\nThen press /paid`);
  } else if (text === '/paid') {
    const isPrem = subs.subscribers[chatId]?.plan === 'premium' && subs.subscribers[chatId]?.expiresAt > Date.now();
    if (isPrem) {
      await sendMsg(bot.token, chatId, '\u2705 You already have active Premium! Use /signals to see all signals.');
      return;
    }
    if (!subs.pendingPayments[chatId] || subs.pendingPayments[chatId].confirmed) {
      subs.pendingPayments[chatId] = { username: from.username, ts: Date.now() };
      await saveJson(subsPath, subs);
    }
    await sendMsg(bot.token, chatId,
      '\u{1F50D} *Checking blockchain...*\n\n' +
      'Bot verifies USDT TRC-20 payments every 60 seconds.\n' +
      'If correct amount was sent, you\u2019ll get Premium automatically within 1-5 minutes.\n\n' +
      `Expected: *${SUB_PRICE}+ USDT* to \`${USDT_ADDRESS}\`\n` +
      'Network: *TRC-20 (TRON)* only\n\n' +
      'Still waiting after 10 min? Contact @trixer666');
  } else if (text === '/status') {
    const sub = subs.subscribers[chatId];
    if (sub?.plan === 'premium' && sub.expiresAt > Date.now()) {
      const days = Math.ceil((sub.expiresAt - Date.now()) / 86400000);
      await sendMsg(bot.token, chatId, `\u{1F48E} *PREMIUM* \u2014 ${days} days left`);
    } else {
      const bonus = sub?.bonusSignals || 0;
      const extra = bonus > 0 ? `\n\u{1F381} Bonus signals: *${bonus}* (use /free)` : '';
      await sendMsg(bot.token, chatId, `\u{1F4CA} *FREE* plan${extra}\n\n/subscribe for Premium`);
    }
  } else if (text === '/signals') {
    const scraped = await loadJson(SCRAPED_PATH, { signals: [] });
    const recent = scraped.signals.slice(-3);
    const sigKb = {
      inline_keyboard: [[
        { text: '\u{1F504} Refresh', callback_data: 'signals' },
        { text: '\u{1F48E} Get Premium', callback_data: 'subscribe' },
      ]],
    };
    if (!recent.length) {
      await sendMsg(bot.token, chatId, '\u{1F4ED} No signals yet. Stay tuned!', { reply_markup: sigKb });
    } else {
      const isPrem = subs.subscribers[chatId]?.plan === 'premium' && subs.subscribers[chatId]?.expiresAt > Date.now();
      const limit = isPrem ? 5 : 1;
      let response = recent.slice(-limit).map(s => {
        const dir = s.direction === 'LONG' ? '\u{1F7E2}' : s.direction === 'SHORT' ? '\u{1F534}' : '\u{1F4CA}';
        const tag = s.num ? `*#${s.num}* ` : '';
        return `${tag}${dir} *${s.pair || '?'}* ${s.direction || ''} ${s.entry ? 'Entry: `$' + s.entry + '`' : ''}`;
      }).join('\n');
      if (!isPrem) response += `\n\n\u{1F512} _${Math.max(0, recent.length - limit)} more in Premium_ \u2014 /subscribe\n\u{1F381} Or use /free for a full signal.`;
      await sendMsg(bot.token, chatId, response, { reply_markup: sigKb });
    }
  } else if (text === '/performance' || text === '/perf') {
    const scraped = await loadJson(SCRAPED_PATH, { signals: [] });
    const sigs = scraped.signals || [];
    const total = sigs.length;
    const longs = sigs.filter(s => s.direction === 'LONG').length;
    const shorts = sigs.filter(s => s.direction === 'SHORT').length;
    const pairCounts = {};
    for (const s of sigs) if (s.pair) pairCounts[s.pair] = (pairCounts[s.pair] || 0) + 1;
    const topPairs = Object.entries(pairCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const srcCounts = {};
    for (const s of sigs) if (s.source) srcCounts[s.source] = (srcCounts[s.source] || 0) + 1;
    const topSrcs = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const divider = '\u2500'.repeat(20);
    let resp = `\u{1F4C8} *Performance*\n${divider}\n`;
    resp += `\u{1F4CA} Total signals: *${total}*\n`;
    resp += `\u{1F7E2} LONG: *${longs}*  \u{1F534} SHORT: *${shorts}*\n`;
    if (topPairs.length) {
      resp += `\n*Top Pairs:*\n` + topPairs.map(([p, c]) => `\u2022 \`${p}\` \u2014 ${c}`).join('\n') + '\n';
    }
    if (topSrcs.length) {
      resp += `\n*Top Sources:*\n` + topSrcs.map(([s, c]) => `\u2022 ${s} \u2014 ${c}`).join('\n');
    }
    if (!total) resp += `\n_No signals scraped yet. Check back soon._`;
    await sendMsg(bot.token, chatId, resp);
  } else if (text === '/help') {
    await sendMsg(bot.token, chatId,
      `\u2753 *How to use this bot:*\n\n` +
      `\u2022 /signals \u2014 latest signal previews\n` +
      `\u2022 /free \u2014 1 full signal per 24h (no payment)\n` +
      `\u2022 /pnl \u2014 theoretical P&L on recent signals\n` +
      `\u2022 /referral \u2014 invite link + bonus signals\n` +
      `\u2022 /subscribe \u2014 Premium ($${SUB_PRICE} USDT/msc)\n` +
      `\u2022 /paid \u2014 after sending USDT (TRC-20)\n` +
      `\u2022 /status \u2014 your plan & bonuses\n` +
      `\u2022 /performance \u2014 aggregate stats\n\n` +
      `Premium = ALL signals instantly + whale alerts.\n` +
      `Questions? Contact @trixer666`);
  } else if (!isOwner && text.length > 3) {
    await sendMsg(cfg.telegramToken, cfg.telegramChatId,
      `\u{1F4AC} @${botUsername} \u2014 @${from.username || 'anon'}: ${text.slice(0, 200)}`);
  }
}

main();
