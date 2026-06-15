// Telegram service bot — auto-responds to potential clients
// Runs alongside income-radar server
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(ROOT, 'config.json');
const leadsPath = join(ROOT, 'data', 'bot-leads.json');

async function loadConfig() {
  return JSON.parse(await readFile(cfgPath, 'utf8'));
}

async function loadLeads() {
  try { return JSON.parse(await readFile(leadsPath, 'utf8')); }
  catch { return { leads: [], stats: { totalMessages: 0, hireRequests: 0 } }; }
}

async function saveLeads(data) {
  await writeFile(leadsPath, JSON.stringify(data, null, 2));
}

const SERVICES = `🤖 **Patryk — Automation Developer**

Buduję systemy które pracują za Ciebie 24/7.

🔧 **Usługi:**
• Telegram boty (alerty, scraping, integracje)
• Web scraping i monitoring cen
• Automatyzacja procesów (n8n, Make, custom)
• AI integracje (chatboty, analiza danych)
• Dashboardy i panele webowe

💰 **Cennik orientacyjny:**
• Prosty bot Telegram: 500-1500 PLN
• Web scraper + alerty: 800-2000 PLN
• Automatyzacja procesu: 1500-5000 PLN
• AI chatbot firmowy: 3000-10000 PLN
• Dashboard/panel: 2000-6000 PLN

📋 Napisz /hire żeby opisać swój projekt
📧 Lub napisz: patrykjaros529@gmail.com
🌐 Portfolio: trixer666.github.io`;

const HIRE_MSG = `📋 **Opisz swój projekt:**

Napisz w jednej wiadomości:
1. Co chcesz zautomatyzować?
2. Jaki masz budżet?
3. Na kiedy potrzebujesz?

Odpowiem w ciągu kilku godzin.`;

let offset = 0;

async function pollUpdates(token) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(35000) }
    );
    const data = await res.json();
    return data.result || [];
  } catch { return []; }
}

async function sendMessage(token, chatId, text, opts = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...opts }),
  });
}

async function handleMessage(msg, cfg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const from = msg.from;
  const isOwner = String(chatId) === String(cfg.telegramChatId);

  // Load leads
  const leads = await loadLeads();
  leads.stats.totalMessages++;

  if (text === '/start') {
    await sendMessage(cfg.telegramToken, chatId, SERVICES);
    // Log lead
    if (!isOwner) {
      leads.leads.push({
        chatId, username: from.username, name: `${from.first_name || ''} ${from.last_name || ''}`.trim(),
        action: 'start', ts: Date.now()
      });
      // Notify owner
      await sendMessage(cfg.telegramToken, cfg.telegramChatId,
        `👤 Nowy user na bocie!\n@${from.username || 'brak'} (${from.first_name || '?'})\nChat ID: ${chatId}`);
    }
  } else if (text === '/hire') {
    await sendMessage(cfg.telegramToken, chatId, HIRE_MSG);
    leads.stats.hireRequests++;
    if (!isOwner) {
      await sendMessage(cfg.telegramToken, cfg.telegramChatId,
        `🎯 /hire request od @${from.username || 'brak'} (${from.first_name || '?'})`);
    }
  } else if (text === '/portfolio') {
    await sendMessage(cfg.telegramToken, chatId,
      `🌐 Portfolio: https://trixer666.github.io\n📦 GitHub: https://github.com/trixer666\n🤖 Featured: https://github.com/trixer666/income-radar`);
  } else if (text === '/stats' && isOwner) {
    const l = await loadLeads();
    await sendMessage(cfg.telegramToken, chatId,
      `📊 Bot stats:\nTotal messages: ${l.stats.totalMessages}\nHire requests: ${l.stats.hireRequests}\nLeads: ${l.leads.length}`);
  } else if (!isOwner && text.length > 10) {
    // Forward potential client message to owner
    await sendMessage(cfg.telegramToken, cfg.telegramChatId,
      `💬 Wiadomość od @${from.username || 'brak'} (${from.first_name || '?'}):\n\n${text}`);
    await sendMessage(cfg.telegramToken, chatId,
      `✅ Dzięki! Przekazałem wiadomość. Odpowiem w ciągu kilku godzin.\n\nW międzyczasie sprawdź portfolio: trixer666.github.io`);
    leads.leads.push({
      chatId, username: from.username, name: `${from.first_name || ''} ${from.last_name || ''}`.trim(),
      action: 'message', text: text.slice(0, 500), ts: Date.now()
    });
  }

  await saveLeads(leads);
}

async function main() {
  const cfg = await loadConfig();
  console.log(`[tg-bot] Started @jarkens_bot — listening for messages...`);
  console.log(`[tg-bot] Commands: /start, /hire, /portfolio, /stats (owner only)`);

  // Set bot commands
  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Oferta usług' },
        { command: 'hire', description: 'Opisz swój projekt' },
        { command: 'portfolio', description: 'Zobacz portfolio' },
      ]
    })
  });

  // Set bot description
  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setMyDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'Patryk — Automation Developer. Telegram boty, web scraping, AI integracje, dashboardy. Napisz /start żeby zobaczyć ofertę.'
    })
  });

  while (true) {
    try {
      const updates = await pollUpdates(cfg.telegramToken);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handleMessage(u.message, cfg);
      }
    } catch (e) {
      console.error('[tg-bot] poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
