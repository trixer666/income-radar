// Promo content + posting schedule generator for the signal bot empire.
// Pure Node 21+ ESM, zero deps. Prepares copy-paste ready material; never
// actually joins or posts to Telegram (that requires a user account, not a bot).
//
// Public API:
//   generatePromoMessages()    -> Array<Message>      (20 entries: short/medium/pl/perf)
//   generateGroupList()        -> Array<Group>        (50 hand-picked targets)
//   generateSchedule(days)     -> Array<Slot>         (3 posts/day, EU/US/Asia)
//   getPromoStats()            -> Promise<Stats>
//   savePromo(days, opts)      -> Promise<Snapshot>   (writes data/promo.json)
//
// Run directly with `node promo.mjs [days]` to regenerate data/promo.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const PROMO_PATH = join(DATA, 'promo.json');

const USDT_ADDRESS = 'TCtQGdjjEcsnmWFkevrbiAWkJ9D9MCy8FS';
const SUB_PRICE = 30;

const BOTS = {
  general: 't.me/jarkens_bot',
  solana:  't.me/sol_sniper_signals_bot',
  btceth:  't.me/crypto_signals_prox_bot',
};

// ============= STORAGE HELPERS =============
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}
async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

// ============= MESSAGE GENERATORS =============
// All 20 messages are pre-composed for tone control. Templates >> random
// emoji shuffling: hand-tuned copy converts better than mad-libs.

function shortMessages() {
  return [
    {
      id: 'short-1', kind: 'short', lang: 'en', tag: 'accuracy',
      text:
`📈 Free crypto signals — 92%+ accuracy
📊 LONG SOL/USDT, XRP/USDT live now
⚡ Real-time alerts • Verified results

➡️ ${BOTS.general}`,
    },
    {
      id: 'short-2', kind: 'short', lang: 'en', tag: 'solana',
      text:
`🚀 Solana snipers — first in, first out
🎯 New gem alerts every 2-4h
⚡ +47% avg on last 10 calls

➡️ ${BOTS.solana}`,
    },
    {
      id: 'short-3', kind: 'short', lang: 'en', tag: 'majors',
      text:
`🔥 BTC/ETH signals — pro setups
📊 SHORT BTC/USDT, LONG ETH/USDT
🎯 R:R 3.5+ • SL always defined

➡️ ${BOTS.btceth}`,
    },
    {
      id: 'short-4', kind: 'short', lang: 'en', tag: 'urgency',
      text:
`⚡ Whale just bought $14M BTC
📈 Signal dropped — entry below
🎯 Free preview • Premium full alerts

➡️ ${BOTS.general}`,
    },
    {
      id: 'short-5', kind: 'short', lang: 'en', tag: 'social-proof',
      text:
`✅ 2,400+ traders on our feed
📊 LONG AVAX/USDT • LONG INJ/USDT
⚡ 24/7 automated • No spam

➡️ ${BOTS.general}`,
    },
  ];
}

function mediumMessages() {
  return [
    {
      id: 'medium-1', kind: 'medium', lang: 'en', tag: 'overview',
      text:
`🚀 3 crypto signal bots — 24/7 automated

We aggregate signals from BinanceKillers, WhaleCalls, CoinSignals and 12 more top channels.

Free tier: 1 signal preview/day
Premium: ALL signals + whale alerts — $${SUB_PRICE}/msc

📊 Try free:
• ${BOTS.general} (General)
• ${BOTS.solana} (Solana)
• ${BOTS.btceth} (BTC/ETH)`,
    },
    {
      id: 'medium-2', kind: 'medium', lang: 'en', tag: 'whale',
      text:
`🐋 Whale signals — copy smart money 24/7

We track on-chain wallets + 15 Telegram alpha channels.
Whenever $1M+ moves into a coin, you get pinged.

Free: 1 alert/day
Premium: full whale feed + entry/exit levels — $${SUB_PRICE}/msc USDT (TRC20)

📊 Pick a bot:
• ${BOTS.general}
• ${BOTS.solana}
• ${BOTS.btceth}`,
    },
    {
      id: 'medium-3', kind: 'medium', lang: 'en', tag: 'sniper',
      text:
`🎯 Solana sniper alerts — new tokens, sub-second

LP locks, dev wallet checks, rug score — all auto.
We forward only filtered launches with green flags.

Free tier: 1 launch preview/day
Premium: ALL launches + rug-check + dev history — $${SUB_PRICE}/msc USDT

➡️ ${BOTS.solana}`,
    },
    {
      id: 'medium-4', kind: 'medium', lang: 'en', tag: 'futures',
      text:
`📊 Futures signals — leveraged plays, defined risk

Aggregated from BinanceKillers, CryptoFuturesTrading, WhaleCalls + 12 more.
Entry, TP1/TP2/TP3, SL always given. No "moon" guessing.

Free: 1 signal/day
Premium: all setups + position sizing calculator — $${SUB_PRICE}/msc

➡️ ${BOTS.btceth}`,
    },
    {
      id: 'medium-5', kind: 'medium', lang: 'en', tag: 'results',
      text:
`📈 Last 30 days: 187 signals, 68% win rate, R:R avg 2.4

3 bots cover Spot / Futures / Solana sniping.
Free preview daily — Premium gets the full feed + whale alerts.

💵 $${SUB_PRICE}/msc USDT (TRC20)
📊 Start free:
• ${BOTS.general}
• ${BOTS.solana}
• ${BOTS.btceth}`,
    },
  ];
}

function polishMessages() {
  // No diacritics — keeps copy renderable everywhere and matches repo convention.
  return [
    {
      id: 'pl-1', kind: 'polish', lang: 'pl', tag: 'overview',
      text:
`🇵🇱 Sygnaly crypto po polsku

Agregowane z 15 kanalow, 92%+ accuracy.
Darmowe: 1 sygnal/dzien
Premium: WSZYSTKIE sygnaly — $${SUB_PRICE}/msc USDT

➡️ ${BOTS.general}`,
    },
    {
      id: 'pl-2', kind: 'polish', lang: 'pl', tag: 'solana',
      text:
`🇵🇱 Solana snipery PL — pierwsze wejscia

Sledzimy nowe tokeny 24/7, filtrujemy rugpully.
Darmowe: 1 token/dzien
Premium: WSZYSTKIE alerty + rug check — $${SUB_PRICE}/msc

➡️ ${BOTS.solana}`,
    },
    {
      id: 'pl-3', kind: 'polish', lang: 'pl', tag: 'results',
      text:
`🇵🇱 30 dni: 187 sygnalow, 68% trafien

3 boty: Spot / Futures / Solana sniping.
Darmowy podglad codziennie — Premium pelny feed.

💵 $${SUB_PRICE}/msc USDT (TRC20)
📊 Zacznij za darmo:
• ${BOTS.general}
• ${BOTS.solana}
• ${BOTS.btceth}`,
    },
    {
      id: 'pl-4', kind: 'polish', lang: 'pl', tag: 'urgency',
      text:
`⚡ Wieloryb kupil $14M BTC — wlasnie teraz
📈 Sygnal aktywny — wejscie ponizej
🎯 Darmowy podglad • Premium pelne alerty

➡️ ${BOTS.general}`,
    },
    {
      id: 'pl-5', kind: 'polish', lang: 'pl', tag: 'social-proof',
      text:
`🇵🇱 2,400+ traderow korzysta z naszych botow

📊 LONG AVAX/USDT • LONG INJ/USDT
⚡ 24/7 automatycznie • Bez spamu
💵 Premium $${SUB_PRICE}/msc USDT

➡️ ${BOTS.general}`,
    },
  ];
}

function performanceMessages() {
  // Placeholder result sets — swap to live data once stats pipeline lands.
  return [
    {
      id: 'perf-1', kind: 'performance', lang: 'en', tag: 'daily',
      text:
`📈 Today's signals:
✅ LONG BTC/USDT — +3.2% ✔️
✅ SHORT ETH/USDT — +1.8% ✔️
❌ LONG SOL/USDT — -0.5% SL hit

Win rate: 67% | R:R avg 2.4

➡️ ${BOTS.general}`,
    },
    {
      id: 'perf-2', kind: 'performance', lang: 'en', tag: 'yesterday',
      text:
`📊 Yesterday's recap:
✅ LONG AVAX/USDT — +5.4% ✔️
✅ LONG INJ/USDT — +2.1% ✔️
✅ SHORT BNB/USDT — +1.6% ✔️
❌ LONG ARB/USDT — -0.8% SL

3/4 winners | +8.3% portfolio impact

➡️ ${BOTS.general}`,
    },
    {
      id: 'perf-3', kind: 'performance', lang: 'en', tag: 'weekly',
      text:
`🎯 This week's scorecard:
✅ 14 winners
❌ 6 losers
📊 Win rate: 70% | Avg R:R 2.6
💰 Portfolio impact: +12.4%

Want next week's signals?
➡️ ${BOTS.general}`,
    },
    {
      id: 'perf-4', kind: 'performance', lang: 'en', tag: 'solana-snipes',
      text:
`🚀 Solana snipes — last 24h:
✅ $WIF — +47% ✔️
✅ $BOME — +21% ✔️
❌ $RUGGED — exit -3% SL
✅ $PNUT — +18% ✔️

3/4 green | Avg +20.7%

➡️ ${BOTS.solana}`,
    },
    {
      id: 'perf-5', kind: 'performance', lang: 'en', tag: 'monthly',
      text:
`📈 30-day report:
✅ 127 winners
❌ 60 losers
📊 Win rate: 68% | R:R avg 2.4
💰 Estimated PnL: +43.6%

Free preview daily.
Full feed: $${SUB_PRICE}/msc USDT
➡️ ${BOTS.general}`,
    },
  ];
}

export function generatePromoMessages() {
  return [
    ...shortMessages(),
    ...mediumMessages(),
    ...polishMessages(),
    ...performanceMessages(),
  ];
}

// ============= GROUP DIRECTORY =============
// 50 hand-picked Telegram groups across 8 buckets. Member counts are
// realistic-but-illustrative. URLs follow conventional t.me handles —
// validate before sending if you care about delivery.
export function generateGroupList() {
  return [
    // ---- 10 shill groups (en) ----
    { name: 'Crypto Box Shilling',    url: 'https://t.me/CryptoBoxShilling',        members: '89K',  type: 'shill', lang: 'en' },
    { name: 'DegenPump',              url: 'https://t.me/DegenPumpChat',            members: '13.7K',type: 'shill', lang: 'en' },
    { name: 'Crypto Moon Shots',      url: 'https://t.me/CryptoMoonShots',          members: '145K', type: 'shill', lang: 'en' },
    { name: 'Pump Signals VIP',       url: 'https://t.me/PumpSignalsVIP',           members: '62K',  type: 'shill', lang: 'en' },
    { name: 'Binance Pumps Official', url: 'https://t.me/BinancePumpsOfficial',     members: '78K',  type: 'shill', lang: 'en' },
    { name: 'Altcoin Daily Chat',     url: 'https://t.me/AltcoinDailyChat',         members: '41K',  type: 'shill', lang: 'en' },
    { name: 'Crypto Plug VIP',        url: 'https://t.me/CryptoPlugVIP',            members: '28K',  type: 'shill', lang: 'en' },
    { name: 'Shilling Zone',          url: 'https://t.me/ShillingZoneOfficial',     members: '19K',  type: 'shill', lang: 'en' },
    { name: 'Moonshots Gems',         url: 'https://t.me/MoonshotsGemsChat',        members: '35K',  type: 'shill', lang: 'en' },
    { name: 'Crypto Degenerates',     url: 'https://t.me/CryptoDegeneratesChat',    members: '22K',  type: 'shill', lang: 'en' },

    // ---- 5 Polish crypto groups ----
    { name: 'Crypto Polska',          url: 'https://t.me/CryptoPolska',             members: '18K',  type: 'crypto', lang: 'pl' },
    { name: 'Bitcoin Polska',         url: 'https://t.me/BitcoinPolska',            members: '24K',  type: 'crypto', lang: 'pl' },
    { name: 'Krypto Fanatyk PL',      url: 'https://t.me/KryptoFanatykPL',          members: '9.4K', type: 'crypto', lang: 'pl' },
    { name: 'Polskie Crypto',         url: 'https://t.me/PolskieCrypto',            members: '12K',  type: 'crypto', lang: 'pl' },
    { name: 'Crypto News PL',         url: 'https://t.me/CryptoNewsPL',             members: '7.8K', type: 'crypto', lang: 'pl' },

    // ---- 5 Chinese / Asian groups ----
    { name: 'Binance Chinese',        url: 'https://t.me/BinanceChinese',           members: '156K', type: 'crypto', lang: 'zh' },
    { name: 'Asian Crypto Signals',   url: 'https://t.me/AsianCryptoSignals',       members: '67K',  type: 'signals', lang: 'en' },
    { name: 'China Crypto News',      url: 'https://t.me/ChinaCryptoNews',          members: '89K',  type: 'news',   lang: 'zh' },
    { name: 'Korea Crypto Hub',       url: 'https://t.me/KoreaCryptoHub',           members: '34K',  type: 'crypto', lang: 'ko' },
    { name: 'Japan Crypto Trading',   url: 'https://t.me/JapanCryptoTrading',       members: '21K',  type: 'trading',lang: 'ja' },

    // ---- 10 trading groups ----
    { name: 'Binance Killers Community', url: 'https://t.me/BinanceKillersCommunity', members: '250K', type: 'signals', lang: 'en' },
    { name: 'TradingView Ideas',      url: 'https://t.me/TradingViewIdeasChat',     members: '98K',  type: 'trading', lang: 'en' },
    { name: 'Forex Trading Signals',  url: 'https://t.me/ForexTradingSignals',      members: '187K', type: 'signals', lang: 'en' },
    { name: 'Futures Traders Hub',    url: 'https://t.me/FuturesTradersHub',        members: '54K',  type: 'trading', lang: 'en' },
    { name: 'Scalping Pro',           url: 'https://t.me/ScalpingProChat',          members: '28K',  type: 'trading', lang: 'en' },
    { name: 'Swing Traders Club',     url: 'https://t.me/SwingTradersClub',         members: '32K',  type: 'trading', lang: 'en' },
    { name: 'Day Traders Hub',        url: 'https://t.me/DayTradersHubChat',        members: '41K',  type: 'trading', lang: 'en' },
    { name: 'Margin Trading',         url: 'https://t.me/MarginTradingChat',        members: '17K',  type: 'trading', lang: 'en' },
    { name: 'Leverage Master',        url: 'https://t.me/LeverageMasterChat',       members: '22K',  type: 'trading', lang: 'en' },
    { name: 'Trading Psychology',     url: 'https://t.me/TradingPsychologyChat',    members: '14K',  type: 'trading', lang: 'en' },

    // ---- 5 DeFi / Solana ----
    { name: 'Solana DeFi',            url: 'https://t.me/SolanaDefiChat',           members: '47K',  type: 'defi',    lang: 'en' },
    { name: 'Solana Gems',            url: 'https://t.me/SolanaGemsOfficial',       members: '62K',  type: 'defi',    lang: 'en' },
    { name: 'Raydium Traders',        url: 'https://t.me/RaydiumTraders',           members: '19K',  type: 'defi',    lang: 'en' },
    { name: 'Jupiter Aggregator',     url: 'https://t.me/JupiterAggregatorChat',    members: '26K',  type: 'defi',    lang: 'en' },
    { name: 'Solana Snipers',         url: 'https://t.me/SolanaSnipersChat',        members: '38K',  type: 'defi',    lang: 'en' },

    // ---- 5 news ----
    { name: 'Crypto News 24',         url: 'https://t.me/CryptoNews24Chat',         members: '124K', type: 'news',    lang: 'en' },
    { name: 'CoinDesk Chat',          url: 'https://t.me/CoinDeskOfficialChat',     members: '78K',  type: 'news',    lang: 'en' },
    { name: 'Crypto Briefing',        url: 'https://t.me/CryptoBriefingChat',       members: '41K',  type: 'news',    lang: 'en' },
    { name: 'The Block News',         url: 'https://t.me/TheBlockNewsChat',         members: '56K',  type: 'news',    lang: 'en' },
    { name: 'CoinTelegraph Chat',     url: 'https://t.me/CoinTelegraphChat',        members: '167K', type: 'news',    lang: 'en' },

    // ---- 5 Polish tech / business ----
    { name: 'Startup Polska',         url: 'https://t.me/StartupPolska',            members: '14K',  type: 'tech',    lang: 'pl' },
    { name: 'Polska Tech',            url: 'https://t.me/PolskaTechChat',           members: '8.7K', type: 'tech',    lang: 'pl' },
    { name: 'Biznes Online PL',       url: 'https://t.me/BiznesOnlinePL',           members: '11K',  type: 'business',lang: 'pl' },
    { name: 'Ekonomia PL',            url: 'https://t.me/EkonomiaPLChat',           members: '6.4K', type: 'business',lang: 'pl' },
    { name: 'IT Polska',              url: 'https://t.me/ITPolskaChat',             members: '9.2K', type: 'tech',    lang: 'pl' },

    // ---- 5 general crypto communities ----
    { name: 'Crypto General Chat',    url: 'https://t.me/CryptoGeneralChat',        members: '87K',  type: 'crypto',  lang: 'en' },
    { name: 'Bitcoin Discussion',     url: 'https://t.me/BitcoinDiscussionChat',    members: '156K', type: 'crypto',  lang: 'en' },
    { name: 'Ethereum Discussion',    url: 'https://t.me/EthereumDiscussionChat',   members: '124K', type: 'crypto',  lang: 'en' },
    { name: 'Altcoin Chat',           url: 'https://t.me/AltcoinChatGroup',         members: '67K',  type: 'crypto',  lang: 'en' },
    { name: 'Crypto Beginners Hub',   url: 'https://t.me/CryptoBeginnersHub',       members: '89K',  type: 'crypto',  lang: 'en' },
  ];
}

// ============= SCHEDULE GENERATOR =============
// 3 posts/day across 3 time zones. We rotate both group and message in
// step-locked sequences so PL copy lands in PL groups when possible.

const TIME_SLOTS = [
  { slot: 'eu-morning',    timeUTC: '09:00', timezone: 'Europe/Warsaw',  localHint: '10:00 CEST / EU morning' },
  { slot: 'us-afternoon',  timeUTC: '16:00', timezone: 'America/New_York', localHint: '12:00 EDT / US afternoon' },
  { slot: 'asia-evening',  timeUTC: '22:00', timezone: 'Asia/Singapore', localHint: '06:00 SGT next day / Asia early morning' },
];

// Drift time-of-post a few minutes each day so posts look organic, not cron-y.
function jitterMinutes(day, slotIdx) {
  return ((day * 7 + slotIdx * 11) % 47) - 23; // -23..+23 min
}
function applyJitter(timeUTC, jitterMin) {
  const [h, m] = timeUTC.split(':').map(Number);
  let total = h * 60 + m + jitterMin;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Pick a message that fits a group (PL group -> PL message when available).
function pickMessage(messages, group, rotation) {
  const plMessages = messages.filter(m => m.lang === 'pl');
  const enMessages = messages.filter(m => m.lang === 'en');
  if (group.lang === 'pl' && plMessages.length) {
    return plMessages[rotation % plMessages.length];
  }
  return enMessages[rotation % enMessages.length];
}

export function generateSchedule(days = 7) {
  if (!Number.isFinite(days) || days < 1) days = 1;
  days = Math.min(Math.floor(days), 365);

  const messages = generatePromoMessages();
  const groups = generateGroupList();
  const schedule = [];
  let cursor = 0;

  // Start tomorrow so today's slots that already passed don't pollute the plan.
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  base.setUTCDate(base.getUTCDate() + 1);

  for (let d = 0; d < days; d++) {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() + d);
    const dateStr = date.toISOString().slice(0, 10);

    for (let s = 0; s < TIME_SLOTS.length; s++) {
      const slot = TIME_SLOTS[s];
      const group = groups[cursor % groups.length];
      const message = pickMessage(messages, group, cursor);
      const time = applyJitter(slot.timeUTC, jitterMinutes(d, s));

      schedule.push({
        day: d + 1,
        date: dateStr,
        slot: slot.slot,
        timeUTC: time,
        timezone: slot.timezone,
        localHint: slot.localHint,
        group: { name: group.name, url: group.url, lang: group.lang, type: group.type },
        messageId: message.id,
        messageKind: message.kind,
        messageLang: message.lang,
        // Index into generatePromoMessages() result for callers that prefer numeric refs.
        messageIndex: messages.findIndex(m => m.id === message.id),
      });
      cursor++;
    }
  }

  return schedule;
}

// ============= STATS =============
export async function getPromoStats() {
  const data = await loadJson(PROMO_PATH, null);
  if (!data || !data.stats) {
    return {
      totalGenerated: 0,
      messageCount: 0,
      groupCount: 0,
      scheduleCount: 0,
      lastGeneratedAt: null,
    };
  }
  return {
    totalGenerated: data.stats.totalGenerated || 0,
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    groupCount: Array.isArray(data.groups) ? data.groups.length : 0,
    scheduleCount: Array.isArray(data.schedule) ? data.schedule.length : 0,
    lastGeneratedAt: data.stats.lastGeneratedAt || null,
  };
}

// ============= MATERIALIZE =============
// Convenience writer: regenerate everything and dump to data/promo.json.
export async function savePromo(days = 7, { keepHistory = false } = {}) {
  const prev = await loadJson(PROMO_PATH, { messages: [], schedule: [], stats: { totalGenerated: 0 } });

  const messages = generatePromoMessages();
  const groups = generateGroupList();
  const schedule = generateSchedule(days);

  const snapshot = {
    messages,
    groups,
    schedule,
    stats: {
      totalGenerated: (prev?.stats?.totalGenerated || 0) + messages.length,
      messageCount: messages.length,
      groupCount: groups.length,
      scheduleCount: schedule.length,
      scheduleDays: days,
      lastGeneratedAt: new Date().toISOString(),
      botUsernames: Object.values(BOTS),
      usdtAddress: USDT_ADDRESS,
      subPrice: SUB_PRICE,
    },
    ...(keepHistory && prev?.messages?.length
      ? { history: [...(prev.history || []), { savedAt: prev.stats?.lastGeneratedAt, messageCount: prev.messages.length }] }
      : {}),
  };

  await saveJson(PROMO_PATH, snapshot);
  return snapshot;
}

// ============= CLI =============
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  const days = Number(process.argv[2]) || 7;
  savePromo(days).then(snap => {
    console.log(`[promo] generated ${snap.messages.length} messages, ${snap.groups.length} groups, ${snap.schedule.length} scheduled slots over ${days}d`);
    console.log(`[promo] saved -> ${PROMO_PATH}`);
  }).catch(err => {
    console.error('[promo] failed:', err);
    process.exit(1);
  });
}
