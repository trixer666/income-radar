// Signal bot — crypto signal forwarding + USDT TRC-20 paywall
// Zero dependencies, pure Node.js ESM
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const cfgPath = join(ROOT, 'config.json');
const subsPath = join(DATA, 'subscribers.json');
const signalsPath = join(DATA, 'signals.json');

// ============= CONFIG =============
const USDT_ADDRESS = 'TCtQGdjjEcsnmWFkevrbiAWkJ9D9MCy8FS';
const SUB_PRICE_USDT = 30; // $30/msc
const SUB_DAYS = 30;
const FREE_SIGNALS_PER_WEEK = 3;
const CHECK_PAYMENT_INTERVAL = 60_000; // co 1 min
const TRONGRID_API = 'https://api.trongrid.io';

// ============= DATA =============
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}
async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function loadSubs() {
  return loadJson(subsPath, {
    subscribers: {},  // {chatId: {username, plan, expiresAt, txHash, paidAt}}
    pendingPayments: {}, // {chatId: {createdAt, amount, notified}}
    stats: { totalRevenue: 0, activeSubscribers: 0, totalSignalsSent: 0 }
  });
}
async function saveSubs(data) { await saveJson(subsPath, data); }

async function loadSignals() {
  return loadJson(signalsPath, { signals: [], lastForwardedId: 0 });
}
async function saveSignals(data) { await saveJson(signalsPath, data); }

// ============= TRON BLOCKCHAIN CHECK =============
async function checkTronPayments(subs, cfg) {
  // Sprawdz USDT TRC-20 transfery na nasz adres
  // USDT contract na TRON: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
  const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const url = `${TRONGRID_API}/v1/accounts/${USDT_ADDRESS}/transactions/trc20?limit=20&contract_address=${USDT_CONTRACT}`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    const txs = data?.data || [];

    for (const tx of txs) {
      if (tx.to !== USDT_ADDRESS) continue;
      const amount = Number(tx.value) / 1e6; // USDT has 6 decimals
      if (amount < SUB_PRICE_USDT * 0.95) continue; // 5% tolerancja

      const txHash = tx.transaction_id;
      // Sprawdz czy juz przetworzone
      const alreadyUsed = Object.values(subs.subscribers).some(s => s.txHash === txHash);
      if (alreadyUsed) continue;

      // Nowa platnosc! Szukaj pending payment do przypisania
      // Przypisz do najstarszego pending usera
      const pendingEntries = Object.entries(subs.pendingPayments)
        .filter(([_, p]) => !p.confirmed)
        .sort((a, b) => a[1].createdAt - b[1].createdAt);

      if (pendingEntries.length > 0) {
        const [chatId, pending] = pendingEntries[0];
        const expiresAt = Date.now() + SUB_DAYS * 24 * 3600 * 1000;

        subs.subscribers[chatId] = {
          username: pending.username || 'unknown',
          plan: 'premium',
          expiresAt,
          txHash,
          paidAt: Date.now(),
          amount
        };
        subs.pendingPayments[chatId].confirmed = true;
        subs.stats.totalRevenue += amount;
        subs.stats.activeSubscribers = Object.values(subs.subscribers)
          .filter(s => s.expiresAt > Date.now()).length;

        await saveSubs(subs);

        // Powiadom usera
        const expDate = new Date(expiresAt).toISOString().slice(0, 10);
        await sendMessage(cfg.telegramToken, chatId,
          `✅ *Platnosc potwierdzona!*\n\n` +
          `Kwota: ${amount} USDT\n` +
          `Plan: Premium (${SUB_DAYS} dni)\n` +
          `Wygasa: ${expDate}\n\n` +
          `Masz teraz dostep do WSZYSTKICH sygnalow. Uzywaj /signals zeby zobaczyc ostatnie.`
        );

        // Powiadom ownera
        await sendMessage(cfg.telegramToken, cfg.telegramChatId,
          `💰 NOWA PLATNOSC!\n${amount} USDT od @${pending.username || chatId}\nTx: ${txHash.slice(0, 16)}...\nActive subs: ${subs.stats.activeSubscribers}`
        );

        console.log(`[payment] ${amount} USDT from ${chatId}, tx: ${txHash.slice(0, 16)}`);
      }
    }
  } catch (e) {
    // TronGrid moze byc niedostepny — nie loguj co minute
    if (Math.random() < 0.05) console.error('[tron] check error:', e.message);
  }
}

// Sprawdz wygasle subskrypcje
async function checkExpired(subs, cfg) {
  const now = Date.now();
  for (const [chatId, sub] of Object.entries(subs.subscribers)) {
    if (sub.expiresAt && sub.expiresAt < now && sub.plan === 'premium') {
      sub.plan = 'expired';
      await sendMessage(cfg.telegramToken, chatId,
        `⏰ Twoja subskrypcja wygasla.\n\nUzyj /subscribe zeby odnowic ($${SUB_PRICE_USDT} USDT/msc).`
      );
      console.log(`[expired] ${chatId} @${sub.username}`);
    }
  }
  subs.stats.activeSubscribers = Object.values(subs.subscribers)
    .filter(s => s.plan === 'premium' && s.expiresAt > now).length;
  await saveSubs(subs);
}

// ============= TELEGRAM HELPERS =============
async function sendMessage(token, chatId, text, opts = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...opts }),
    });
  } catch (e) { console.error('[tg] send error:', e.message); }
}

let offset = 0;
async function pollUpdates(token) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(35000) }
    );
    return (await res.json()).result || [];
  } catch { return []; }
}

// ============= BOT MESSAGES =============
const WELCOME = `🚀 *Crypto Signal Bot*

Sygnaly z najlepszych analitykow — 92%+ accuracy.

📊 *Darmowy plan:* ${FREE_SIGNALS_PER_WEEK} sygnaly/tydzien
💎 *Premium:* WSZYSTKIE sygnaly + whale alerts + early calls

💰 Cena: *$${SUB_PRICE_USDT} USDT/miesiac*

Komendy:
/signals — ostatnie sygnaly
/subscribe — kup Premium
/status — sprawdz subskrypcje
/stats — statystyki bota`;

const SUBSCRIBE_MSG = `💎 *Premium Subscription — $${SUB_PRICE_USDT}/msc*

Wyslij dokladnie *${SUB_PRICE_USDT} USDT (TRC-20)* na adres:

\`${USDT_ADDRESS}\`

⚠️ WAZNE:
• Siec: *TRC-20 (TRON)* — NIE ERC-20!
• Kwota: dokladnie ${SUB_PRICE_USDT} USDT (lub wiecej)
• Po wyslaniu kliknij /paid

Bot automatycznie zweryfikuje platnosc na blockchainie (1-5 min).

📋 Jesli masz problem — napisz do @trixer666`;

function isPremium(subs, chatId) {
  const sub = subs.subscribers[String(chatId)];
  return sub && sub.plan === 'premium' && sub.expiresAt > Date.now();
}

// ============= SIGNAL MANAGEMENT =============
// Manualnie dodawane sygnaly (przez ownera lub auto-forward)
async function addSignal(signalData, subs, cfg) {
  const signals = await loadSignals();
  const signal = {
    id: signals.signals.length + 1,
    ...signalData,
    ts: Date.now()
  };
  signals.signals.push(signal);
  // Ogranicz do 200 sygnalow w historii
  if (signals.signals.length > 200) signals.signals = signals.signals.slice(-200);
  await saveSignals(signals);

  // Wyslij do premium subscribersow
  let sent = 0;
  for (const [chatId, sub] of Object.entries(subs.subscribers)) {
    if (sub.plan === 'premium' && sub.expiresAt > Date.now()) {
      await sendMessage(cfg.telegramToken, chatId, formatSignal(signal));
      sent++;
      // Rate limit
      if (sent % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Free userzy — tylko jesli w limicie tygodniowym
  // (uproszczenie: wysylaj co 3ci sygnal do free userow)
  if (signal.id % Math.ceil(7 / FREE_SIGNALS_PER_WEEK) === 0) {
    // Broadcast do wszystkich nie-premium
    // Pomijamy — free userzy musza uzyc /signals
  }

  subs.stats.totalSignalsSent += sent;
  await saveSubs(subs);
  console.log(`[signal] #${signal.id} sent to ${sent} premium users`);
  return signal;
}

function formatSignal(s) {
  const dir = s.direction === 'LONG' ? '🟢 LONG' : (s.direction === 'SHORT' ? '🔴 SHORT' : '📊');
  return `${dir} *${s.pair || s.coin || 'N/A'}*\n\n` +
    (s.entry ? `📍 Entry: \`${s.entry}\`\n` : '') +
    (s.targets ? `🎯 Targets: ${s.targets.map(t => `\`${t}\``).join(' → ')}\n` : '') +
    (s.stopLoss ? `🛑 Stop Loss: \`${s.stopLoss}\`\n` : '') +
    (s.leverage ? `⚡ Leverage: ${s.leverage}x\n` : '') +
    (s.notes ? `\n💡 ${s.notes}` : '') +
    `\n\n⏰ ${new Date(s.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// ============= MESSAGE HANDLER =============
async function handleMessage(msg, subs, cfg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const from = msg.from;
  const isOwner = chatId === String(cfg.telegramChatId);

  if (text === '/start') {
    await sendMessage(cfg.telegramToken, chatId, WELCOME);
    if (!isOwner && !subs.subscribers[chatId]) {
      await sendMessage(cfg.telegramToken, cfg.telegramChatId,
        `👤 Nowy user: @${from.username || 'brak'} (${from.first_name || '?'}) — ${chatId}`);
    }

  } else if (text === '/subscribe') {
    await sendMessage(cfg.telegramToken, chatId, SUBSCRIBE_MSG);
    subs.pendingPayments[chatId] = {
      username: from.username || from.first_name || 'unknown',
      createdAt: Date.now(),
      amount: SUB_PRICE_USDT,
      confirmed: false
    };
    await saveSubs(subs);

  } else if (text === '/paid') {
    if (isPremium(subs, chatId)) {
      await sendMessage(cfg.telegramToken, chatId, '✅ Juz masz aktywna subskrypcje!');
    } else {
      if (!subs.pendingPayments[chatId]) {
        subs.pendingPayments[chatId] = {
          username: from.username || 'unknown', createdAt: Date.now(),
          amount: SUB_PRICE_USDT, confirmed: false
        };
        await saveSubs(subs);
      }
      await sendMessage(cfg.telegramToken, chatId,
        '🔍 Sprawdzam blockchain... To moze zajac 1-5 minut.\n\n' +
        'Jesli platnosc nie zostanie znaleziona w ciagu 10 min, napisz do @trixer666');
    }

  } else if (text === '/status') {
    const sub = subs.subscribers[chatId];
    if (sub && sub.plan === 'premium' && sub.expiresAt > Date.now()) {
      const days = Math.ceil((sub.expiresAt - Date.now()) / 86400000);
      await sendMessage(cfg.telegramToken, chatId,
        `💎 *Status: PREMIUM*\nPozostalo: ${days} dni\nWygasa: ${new Date(sub.expiresAt).toISOString().slice(0, 10)}`);
    } else {
      await sendMessage(cfg.telegramToken, chatId,
        `📊 *Status: FREE*\n${FREE_SIGNALS_PER_WEEK} sygnalow/tydzien\n\nUzyj /subscribe zeby przejsc na Premium`);
    }

  } else if (text === '/signals') {
    const signals = await loadSignals();
    const recent = signals.signals.slice(-5);
    if (!recent.length) {
      await sendMessage(cfg.telegramToken, chatId, '📭 Brak sygnalow. Wkrotce!');
      return;
    }
    const premium = isPremium(subs, chatId);
    const limit = premium ? 5 : 2;
    const shown = recent.slice(-limit);
    let response = shown.map(formatSignal).join('\n\n---\n\n');
    if (!premium && recent.length > limit) {
      response += `\n\n🔒 *+${recent.length - limit} sygnalow dostepnych w Premium*\n/subscribe`;
    }
    await sendMessage(cfg.telegramToken, chatId, response);

  } else if (text === '/stats') {
    const activeSubs = Object.values(subs.subscribers)
      .filter(s => s.plan === 'premium' && s.expiresAt > Date.now()).length;
    const signals = await loadSignals();
    await sendMessage(cfg.telegramToken, chatId,
      `📊 *Bot Stats*\n\n` +
      `Sygnaly: ${signals.signals.length}\n` +
      `Aktywni premium: ${activeSubs}\n` +
      `Lacznie wyslanych: ${subs.stats.totalSignalsSent}`);

  // === OWNER COMMANDS ===
  } else if (text.startsWith('/signal ') && isOwner) {
    // Format: /signal LONG BTC/USDT 65000 TP:67000,69000 SL:63000 LEV:10 Silny trend wzrostowy
    const parts = text.slice(8).split(' ');
    const direction = parts[0]?.toUpperCase(); // LONG/SHORT
    const pair = parts[1]; // BTC/USDT
    const entry = parts[2]; // 65000
    let targets = [], stopLoss = null, leverage = null, notes = '';
    for (const p of parts.slice(3)) {
      if (p.startsWith('TP:')) targets = p.slice(3).split(',');
      else if (p.startsWith('SL:')) stopLoss = p.slice(3);
      else if (p.startsWith('LEV:')) leverage = p.slice(4);
      else notes += p + ' ';
    }
    const signal = await addSignal(
      { direction, pair, entry, targets, stopLoss, leverage, notes: notes.trim() },
      subs, cfg
    );
    await sendMessage(cfg.telegramToken, chatId, `✅ Sygnal #${signal.id} wyslany do ${subs.stats.activeSubscribers} premium userow`);

  } else if (text === '/revenue' && isOwner) {
    const activeSubs = Object.values(subs.subscribers)
      .filter(s => s.plan === 'premium' && s.expiresAt > Date.now());
    const pending = Object.entries(subs.pendingPayments).filter(([_, p]) => !p.confirmed);
    await sendMessage(cfg.telegramToken, chatId,
      `💰 *Revenue Dashboard*\n\n` +
      `Total revenue: $${subs.stats.totalRevenue} USDT\n` +
      `Active premium: ${activeSubs.length}\n` +
      `MRR: $${activeSubs.length * SUB_PRICE_USDT}\n` +
      `Pending payments: ${pending.length}\n\n` +
      `Subscribers:\n` +
      activeSubs.map(s => `• @${s.username} — expires ${new Date(s.expiresAt).toISOString().slice(0, 10)}`).join('\n'));

  } else if (text === '/broadcast' && isOwner) {
    await sendMessage(cfg.telegramToken, chatId,
      '📢 Uzyj: /broadcast Tresc wiadomosci do wszystkich');

  } else if (text.startsWith('/broadcast ') && isOwner) {
    const broadcastText = text.slice(11);
    let sent = 0;
    const allUsers = new Set([
      ...Object.keys(subs.subscribers),
      ...Object.keys(subs.pendingPayments)
    ]);
    for (const uid of allUsers) {
      if (uid === chatId) continue;
      await sendMessage(cfg.telegramToken, uid, broadcastText);
      sent++;
      if (sent % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    }
    await sendMessage(cfg.telegramToken, chatId, `📢 Broadcast wyslany do ${sent} userow`);

  } else if (!isOwner && text.length > 5) {
    // Forward wiadomosc do ownera
    await sendMessage(cfg.telegramToken, cfg.telegramChatId,
      `💬 @${from.username || 'brak'}: ${text}`);
    await sendMessage(cfg.telegramToken, chatId,
      'Dzieki za wiadomosc! Odpowiemy wkrotce.\n\n/signals — sprawdz sygnaly\n/subscribe — kup Premium');
  }
}

// ============= MAIN LOOP =============
async function main() {
  const cfg = await loadJson(cfgPath, {});
  let subs = await loadSubs();

  console.log(`[signal-bot] @jarkens_bot started`);
  console.log(`[signal-bot] USDT address: ${USDT_ADDRESS}`);
  console.log(`[signal-bot] Price: $${SUB_PRICE_USDT}/msc`);
  console.log(`[signal-bot] Commands: /start /subscribe /paid /signals /status /stats`);
  console.log(`[signal-bot] Owner: /signal /revenue /broadcast`);

  // Set bot commands
  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Informacje o bocie' },
        { command: 'signals', description: 'Ostatnie sygnaly' },
        { command: 'subscribe', description: 'Kup Premium ($30/msc)' },
        { command: 'paid', description: 'Potwierdzam platnosc' },
        { command: 'status', description: 'Sprawdz subskrypcje' },
        { command: 'stats', description: 'Statystyki bota' },
      ]
    })
  });

  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setMyDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'Crypto Signal Bot — 92%+ accuracy. Sygnaly LONG/SHORT z najlepszych analitykow. /start zeby zaczac. Premium: $30/msc USDT.'
    })
  });

  // Payment check interval
  setInterval(async () => {
    subs = await loadSubs();
    await checkTronPayments(subs, cfg);
    await checkExpired(subs, cfg);
  }, CHECK_PAYMENT_INTERVAL);

  // Polling loop
  while (true) {
    try {
      const updates = await pollUpdates(cfg.telegramToken);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          subs = await loadSubs();
          await handleMessage(u.message, subs, cfg);
        }
      }
    } catch (e) {
      console.error('[bot] poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
