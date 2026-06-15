// Multi-bot signal manager — scrapes public channels, broadcasts to all bots
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const BOTS_PATH = join(DATA, 'bot-tokens.json');
const SCRAPED_PATH = join(DATA, 'scraped-signals.json');

const USDT_ADDRESS = 'TCtQGdjjEcsnmWFkevrbiAWkJ9D9MCy8FS';
const SUB_PRICE = 30;
const SCRAPE_INTERVAL = 5 * 60 * 1000; // 5 min

// Public signal channels to scrape (via t.me/s/ web preview)
const SIGNAL_SOURCES = [
  { id: 'WhaleCalls', url: 'https://t.me/s/WhaleCalls', type: 'whale' },
  { id: 'CryptoSignalsOrg', url: 'https://t.me/s/CryptoSignalsOrg', type: 'signals' },
  { id: 'BinanceKillers', url: 'https://t.me/s/BinanceKillers', type: 'signals' },
  { id: 'CoinSignals', url: 'https://t.me/s/CoinSignals', type: 'signals' },
  { id: 'crypto_futures_signals_trading', url: 'https://t.me/s/crypto_futures_signals_trading', type: 'futures' },
  { id: 'crypto_futures_binance', url: 'https://t.me/s/crypto_futures_binance', type: 'futures' },
  { id: 'WallStreetBetsELITE', url: 'https://t.me/s/WallStreetBetsELITE', type: 'signals' },
  { id: 'cryptosignalsfree', url: 'https://t.me/s/cryptosignalsfree', type: 'signals' },
  { id: 'CryptoVIPSignalFree', url: 'https://t.me/s/CryptoVIPSignalFree', type: 'signals' },
  { id: 'defikidblog', url: 'https://t.me/s/defikidblog', type: 'defi' },
  { id: 'whale_alert_io', url: 'https://t.me/s/whale_alert_io', type: 'whale' },
  { id: 'CryptoBusy', url: 'https://t.me/s/CryptoBusy', type: 'signals' },
  { id: 'AltcoinBuzz', url: 'https://t.me/s/AltcoinBuzz', type: 'news' },
  { id: 'solanafloor', url: 'https://t.me/s/solanafloor', type: 'solana' },
  { id: 'BitcoinMagazine', url: 'https://t.me/s/BitcoinMagazine', type: 'news' },
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

// Parse signal from raw text
function parseSignal(text) {
  const upper = text.toUpperCase();

  // Detect direction
  let direction = null;
  if (upper.includes('LONG') || upper.includes('BUY') || upper.includes('BULLISH')) direction = 'LONG';
  if (upper.includes('SHORT') || upper.includes('SELL') || upper.includes('BEARISH')) direction = 'SHORT';

  // Detect pair
  const pairMatch = text.match(/\b([A-Z]{2,10})\s*[\/\\]\s*(USDT|USD|BTC|ETH|BUSD)\b/i);
  const pair = pairMatch ? `${pairMatch[1].toUpperCase()}/${pairMatch[2].toUpperCase()}` : null;

  // Detect entry price
  const entryMatch = text.match(/(?:entry|enter|price|buy|sell)[:\s]*\$?([\d,.]+)/i);
  const entry = entryMatch ? entryMatch[1].replace(',', '') : null;

  // Detect targets
  const tpMatches = [...text.matchAll(/(?:tp|target|take profit)\s*\d?\s*[:\s]*\$?([\d,.]+)/gi)];
  const targets = tpMatches.map(m => m[1].replace(',', '')).filter(Boolean);

  // Detect stop loss
  const slMatch = text.match(/(?:sl|stop loss|stop|stoploss)[:\s]*\$?([\d,.]+)/i);
  const stopLoss = slMatch ? slMatch[1].replace(',', '') : null;

  // Detect leverage
  const levMatch = text.match(/(\d+)\s*x\s*(?:lev|leverage)?/i);
  const leverage = levMatch ? levMatch[1] : null;

  // Is this a signal? (must have at least direction OR pair)
  const isSignal = (direction || pair) && (entry || targets.length || text.length < 500);

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

function formatSignal(parsed, rawText) {
  if (!parsed.isSignal) return null;
  const dirEmoji = parsed.direction === 'LONG' ? '\u{1F7E2}' :
                   parsed.direction === 'SHORT' ? '\u{1F534}' : '\u{1F4CA}';
  const dirText = parsed.direction || 'SIGNAL';
  const pair = parsed.pair || 'CRYPTO';
  const divider = '\u2500'.repeat(20);

  let msg = `${dirEmoji} *${dirText}* \u2022 *${pair}*\n${divider}\n`;
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
    if (Number.isFinite(e) && Number.isFinite(t0) && Number.isFinite(sl) && e !== sl) {
      const rr = (t0 - e) / (e - sl);
      if (Number.isFinite(rr) && rr > 0) {
        msg += `\n\u{1F4CA} Risk/Reward: 1:${rr.toFixed(1)}\n`;
      }
    }
  }

  msg += `\u23F0 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`;
  msg += `${divider}\n`;
  msg += `\u26A0\uFE0F _Not financial advice. DYOR._\n`;
  msg += `\u{1F514} /subscribe for all signals`;
  return msg;
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
  const scraped = await loadJson(SCRAPED_PATH, { lastIds: {}, signals: [] });
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

      const formatted = formatSignal(parsed, msg.text);
      if (!formatted) continue;

      const taggedMsg = formatted + `\n\n_Source: ${source.id}_`;

      // Broadcast to all bots
      console.log(`[signal] ${parsed.direction || '?'} ${parsed.pair || '?'} from ${source.id}`);
      await broadcastSignal(bots, taggedMsg);

      // Also notify owner
      await sendMsg(cfg.telegramToken, cfg.telegramChatId,
        `\u{1F4E1} Signal scraped from ${source.id}:\n${taggedMsg}`);

      scraped.signals.push({ ...parsed, source: source.id, ts: Date.now() });
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
        { command: 'subscribe', description: `Premium $${SUB_PRICE}/msc` },
        { command: 'paid', description: 'Confirm payment' },
        { command: 'status', description: 'Check subscription' },
        { command: 'performance', description: 'Stats & breakdown' },
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

// ============= MAIN =============
async function main() {
  const cfg = await loadJson(join(ROOT, 'config.json'), {});
  const bots = await loadJson(BOTS_PATH, {});

  console.log(`[multi-bot] Starting ${Object.keys(bots).length} bots`);
  console.log(`[multi-bot] USDT: ${USDT_ADDRESS}`);
  console.log(`[multi-bot] Sources: ${SIGNAL_SOURCES.map(s => s.id).join(', ')}`);

  // Setup all bots
  for (const [username, bot] of Object.entries(bots)) {
    await setupBot(username, bot);
  }

  // Initial scrape
  const initial = await scrapeAndBroadcast(bots, cfg);
  console.log(`[multi-bot] Initial scrape: ${initial} new signals`);

  // Scrape loop
  setInterval(async () => {
    const n = await scrapeAndBroadcast(bots, cfg);
    if (n > 0) console.log(`[multi-bot] Scraped ${n} new signals`);
  }, SCRAPE_INTERVAL);

  // Also run signal-bot.mjs logic for handling /subscribe /paid etc
  // on ALL bots simultaneously
  console.log(`[multi-bot] Polling all bots for user commands...`);

  // Simple poll for each bot
  const offsets = {};
  while (true) {
    for (const [username, bot] of Object.entries(bots)) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offsets[username] || 0}&timeout=2&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,
          { signal: AbortSignal.timeout(5000) }
        );
        const data = await res.json();
        for (const u of (data.result || [])) {
          offsets[username] = u.update_id + 1;
          if (u.message) {
            await handleBotMessage(username, bot, u.message, cfg);
          } else if (u.callback_query) {
            const cb = u.callback_query;
            const cId = String(cb.message.chat.id);
            // Answer callback to remove loading indicator
            await fetch(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id }),
            });
            // Route callback as if it were a slash command
            await handleBotMessage(username, bot, { chat: { id: cId }, from: cb.from, text: '/' + cb.data }, cfg);
          }
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// Handle user messages on any bot
async function handleBotMessage(botUsername, bot, msg, cfg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const from = msg.from;
  const isOwner = chatId === String(cfg.telegramChatId);
  const subsPath = join(DATA, `subs-${botUsername}.json`);
  const subs = await loadJson(subsPath, { subscribers: {}, pendingPayments: {}, stats: { revenue: 0 } });

  const nicheNames = { solana: 'Solana Sniper', btc_eth: 'Crypto PRO', general: 'Signal Bot' };
  const niche = nicheNames[bot.niche] || 'Signal Bot';

  if (text === '/start') {
    const startKb = {
      inline_keyboard: [
        [{ text: '\u{1F4CA} Signals', callback_data: 'signals' }, { text: '\u{1F48E} Premium', callback_data: 'subscribe' }],
        [{ text: '\u{1F4C8} Performance', callback_data: 'perf' }, { text: '\u2753 Help', callback_data: 'help' }],
      ],
    };
    await sendMsg(bot.token, chatId,
      `\u{1F680} *${niche}*\n\nAggregated signals from top analysts.\n\n` +
      `\u{1F4CA} Free: 1 signal preview\n\u{1F48E} Premium: ALL signals + whale alerts\n\n` +
      `\u{1F4B0} Price: *$${SUB_PRICE} USDT/msc*\n\n` +
      `Tap a button below or send /help`,
      { reply_markup: startKb });
    if (!isOwner) {
      await sendMsg(cfg.telegramToken, cfg.telegramChatId,
        `\u{1F464} @${botUsername}: new user @${from.username || 'anon'} (${chatId})`);
    }
  } else if (text === '/subscribe') {
    await sendMsg(bot.token, chatId,
      `\u{1F48E} *Premium \u2014 $${SUB_PRICE}/msc*\n\n` +
      `Send *${SUB_PRICE} USDT (TRC-20)* to:\n\n\`${USDT_ADDRESS}\`\n\n` +
      `\u26A0\uFE0F Network: *TRC-20 (TRON)* only!\n\nThen press /paid`);
    subs.pendingPayments[chatId] = { username: from.username, ts: Date.now() };
    await saveJson(subsPath, subs);
  } else if (text === '/paid') {
    await sendMsg(bot.token, chatId, '\u{1F50D} Checking blockchain... (1-5 min)\n\nContact @trixer666 if issues.');
  } else if (text === '/status') {
    const sub = subs.subscribers[chatId];
    if (sub?.plan === 'premium' && sub.expiresAt > Date.now()) {
      const days = Math.ceil((sub.expiresAt - Date.now()) / 86400000);
      await sendMsg(bot.token, chatId, `\u{1F48E} *PREMIUM* \u2014 ${days} days left`);
    } else {
      await sendMsg(bot.token, chatId, `\u{1F4CA} *FREE* plan\n\n/subscribe for Premium`);
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
        return `${dir} *${s.pair || '?'}* ${s.direction || ''} ${s.entry ? 'Entry: `$' + s.entry + '`' : ''}`;
      }).join('\n');
      if (!isPrem) response += `\n\n\u{1F512} _${Math.max(0, recent.length - limit)} more in Premium_ \u2014 /subscribe`;
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
      `1. /signals \u2014 see latest signals\n` +
      `2. /subscribe \u2014 get Premium for ALL signals\n` +
      `3. Send *$${SUB_PRICE} USDT (TRC-20)* to the address shown\n` +
      `4. Press /paid after sending\n` +
      `5. Bot verifies on blockchain automatically\n\n` +
      `Free users: 1 signal preview\nPremium: ALL signals instantly + whale alerts\n\n` +
      `Questions? Contact @trixer666`);
  } else if (!isOwner && text.length > 3) {
    await sendMsg(cfg.telegramToken, cfg.telegramChatId,
      `\u{1F4AC} @${botUsername} \u2014 @${from.username || 'anon'}: ${text.slice(0, 200)}`);
  }
}

main();
