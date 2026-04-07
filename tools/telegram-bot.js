/**
 * TELEGRAM BOT — AvatarGenGioIA MCP
 *
 * Flusso:
 *   1. L'utente invia un messaggio Telegram con uno o più topic
 *   2. Claude AI analizza il messaggio e genera la struttura topics (Excel-like)
 *   3. I topics vengono salvati in config/topics.json
 *   4. Il pipeline viene avviato automaticamente per ogni topic
 *   5. Al completamento, i link dei video vengono inviati su Telegram
 *
 * Comandi:
 *   /start        — Messaggio di benvenuto
 *   /status       — Stato corrente del pipeline
 *   /topics       — Lista dei topics in coda
 *   /run          — Forza esecuzione pipeline
 *   (testo libero) — Viene processato dall'AI per creare topics
 */

import TelegramBot from 'node-telegram-bot-api';
import Anthropic   from '@anthropic-ai/sdk';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';
import { config }  from '../config/index.js';
import { logger }  from '../config/logger.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const TOPICS_FILE = path.join(__dirname, '../config/topics.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readTopics() {
  if (!fs.existsSync(TOPICS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); }
  catch { return []; }
}

function saveTopics(topics) {
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2));
}

function getNextId(topics) {
  if (!topics.length) return 1;
  return Math.max(...topics.map(t => t.id)) + 1;
}

// ─── Claude AI: analizza messaggio e genera topics ───────────────────────────

const PARSE_SYSTEM_PROMPT = `Sei l'assistente AI di AvatarGenGioIA, sistema intelligente per la creazione di contenuti video su qualsiasi argomento.

Il tuo compito è analizzare il messaggio dell'utente e trasformarlo in una lista strutturata di topic per video brevi (Instagram Reel, TikTok, YouTube Short).

Per ogni topic che identifichi nel messaggio, genera un oggetto JSON con:
- "topic": titolo breve e chiaro del video (max 60 caratteri)
- "pilastro": categoria tra "educativo", "opinione", "tutorial", "ispirazione", "notizia", "brand"
- "photoId": suggerisci un nome file foto coerente con il contenuto (es. "ai_intro_01.jpg") o lascia vuoto ""
- "parlato": se l'utente ha fornito un testo specifico da dire nel video, mettilo qui. Altrimenti lascia vuoto "" (verrà generato dopo da Claude)
- "note": eventuali note aggiuntive estratte dal messaggio

REGOLE:
- Se l'utente scrive un singolo argomento, genera 1 topic
- Se scrive più argomenti (separati da virgole, punti, elenco), genera più topic
- Se il messaggio è vago, interpreta l'intento migliore possibile per l'argomento indicato
- Rispondi SOLO con un array JSON valido, nessun testo aggiuntivo
- Il pilastro va dedotto dal contenuto:
  * "educativo" = spiega o insegna qualcosa
  * "opinione" = punto di vista, analisi, critica
  * "tutorial" = come fare, step by step
  * "ispirazione" = motiva, ispira, emoziona
  * "notizia" = aggiornamenti, trend, news recenti
  * "brand" = storia, valori, team, presentazione

ESEMPIO INPUT: "fai un video sull'intelligenza artificiale nel lavoro e uno sui rischi della disinformazione"

ESEMPIO OUTPUT:
[
  {"topic":"come l'AI sta cambiando il lavoro nel 2025","pilastro":"educativo","photoId":"ai_lavoro_01.jpg","parlato":"","note":"dati e trend recenti"},
  {"topic":"disinformazione: come riconoscere una notizia falsa","pilastro":"tutorial","photoId":"fact_check.jpg","parlato":"","note":"angolazione pratica"}
]`;

async function parseMessageWithAI(userMessage) {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY mancante — impossibile analizzare il messaggio');
  }

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const response = await client.messages.create({
    model: config.anthropic.model || 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: PARSE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();

  // Estrai JSON dall'output (potrebbe avere backtick markdown)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Claude non ha restituito un JSON valido: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]);
}

// ─── Bot Setup ───────────────────────────────────────────────────────────────

/**
 * Avvia il bot Telegram e restituisce { bot, sendMessage }.
 * @param {Function} onRunPipeline — callback per avviare il pipeline (viene chiamato dal bot)
 * @param {Function} getState      — callback per ottenere lo stato corrente del pipeline
 * @returns {{ bot: TelegramBot, sendMessage: Function }}
 */
export function startTelegramBot(onRunPipeline, getState) {
  const token  = config.telegram?.token;
  const chatId = config.telegram?.chatId;

  if (!token) {
    if (config.isDev) {
      logger.info('Telegram bot disabilitato in locale (TELEGRAM_BOT_TOKEN non configurato)');
    } else {
      logger.warn('TELEGRAM_BOT_TOKEN mancante — bot Telegram non avviato');
    }
    return { bot: null, sendMessage: () => {}, sendVideo: () => Promise.resolve() };
  }

  const bot = new TelegramBot(token, { polling: true });

  logger.info('🤖 Telegram bot avviato (polling)');

  // Utility: invia messaggio al chat autorizzato
  function sendMessage(text, options = {}) {
    const target = chatId || null;
    if (!target) {
      logger.warn('TELEGRAM_CHAT_ID non configurato — impossibile inviare messaggio');
      return;
    }
    return bot.sendMessage(target, text, { parse_mode: 'HTML', ...options });
  }

  // Utility: invia file video al chat autorizzato
  function sendVideo(filePath, caption = '', options = {}) {
    const target = chatId || null;
    if (!target) {
      logger.warn('TELEGRAM_CHAT_ID non configurato — impossibile inviare video');
      return Promise.resolve();
    }
    logger.info(`Telegram: invio video → ${filePath}`);
    return bot.sendVideo(target, filePath, { caption, parse_mode: 'HTML', supports_streaming: true, ...options })
      .catch(err => { logger.error(`Telegram sendVideo error: ${err.message}`); });
  }

  // Controllo autorizzazione (solo il chat_id configurato può interagire)
  function isAuthorized(msg) {
    if (!chatId) return true; // Se non configurato, accetta tutti
    return String(msg.chat.id) === String(chatId);
  }

  // ─── /start ──────────────────────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(msg.chat.id, [
      '🪵 <b>AvatarGenGioIA — Video Pipeline Bot</b>',
      '',
      'Inviami un messaggio con i temi per i video Instagram e farò tutto io:',
      '',
      '1️⃣ Analizzo il tuo messaggio con l\'AI',
      '2️⃣ Creo la struttura dei topic',
      '3️⃣ Genero gli script con Claude',
      '4️⃣ Creo i video con HeyGen',
      '5️⃣ Ti invio i link dei video completati',
      '',
      '<b>Comandi:</b>',
      '/status — Stato pipeline',
      '/topics — Lista topic in coda',
      '/run — Forza esecuzione',
      '',
      '💡 Oppure scrivimi qualcosa come:',
      '<i>"fai un video sull\'intelligenza artificiale nel lavoro e uno sul futuro della robotica"</i>',
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /status ─────────────────────────────────────────────────────────────
  bot.onText(/\/status/, (msg) => {
    if (!isAuthorized(msg)) return;
    const state = getState();
    const statusEmoji = {
      idle: '⏸️', running: '🔄', success: '✅', error: '❌',
    }[state.status] || '❓';

    const steps = state.steps.length
      ? state.steps.map(s => {
          const e = { running: '🔄', done: '✅', error: '❌', skipped: '⏭️' }[s.status] || '⬜';
          return `  ${e} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`;
        }).join('\n')
      : '  Nessuno step in corso';

    bot.sendMessage(msg.chat.id, [
      `${statusEmoji} <b>Pipeline: ${state.status.toUpperCase()}</b>`,
      `🕐 Ultimo run: ${state.lastRun || 'mai'}`,
      `⏰ Cron: ${state.cron}`,
      '',
      '<b>Steps:</b>',
      steps,
      state.lastResult ? `\n📎 Ultimo risultato: ${state.lastResult}` : '',
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /topics ─────────────────────────────────────────────────────────────
  bot.onText(/\/topics/, (msg) => {
    if (!isAuthorized(msg)) return;
    const topics = readTopics();
    if (!topics.length) {
      bot.sendMessage(msg.chat.id, '📭 Nessun topic in coda.\nInviami un messaggio per crearne!');
      return;
    }

    const statusEmoji = { pending: '🟡', 'in-progress': '🔄', done: '✅', skip: '⏭️' };
    const lines = topics.map(t =>
      `${statusEmoji[t.status] || '⬜'} <b>${t.topic}</b>\n   ${t.pilastro} ${t.photoId ? '📷' : ''} ${t.parlato ? '🎙️' : ''}`
    );

    bot.sendMessage(msg.chat.id, [
      `📋 <b>Topics (${topics.length})</b>`,
      '',
      ...lines,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /run ────────────────────────────────────────────────────────────────
  bot.onText(/\/run/, (msg) => {
    if (!isAuthorized(msg)) return;
    const state = getState();
    if (state.status === 'running') {
      bot.sendMessage(msg.chat.id, '⚠️ Pipeline già in esecuzione, attendi il completamento.');
      return;
    }
    bot.sendMessage(msg.chat.id, '🚀 Pipeline avviato!');
    onRunPipeline();
  });

  // ─── Messaggio libero → AI parse + pipeline ──────────────────────────────
  bot.on('message', async (msg) => {
    // Ignora comandi
    if (msg.text?.startsWith('/')) return;
    if (!msg.text?.trim()) return;
    if (!isAuthorized(msg)) return;

    const chatTarget = msg.chat.id;

    try {
      bot.sendMessage(chatTarget, '🧠 Analizzo il tuo messaggio con l\'AI...');

      // 1. Analizza con Claude
      const newTopics = await parseMessageWithAI(msg.text);

      if (!newTopics.length) {
        bot.sendMessage(chatTarget, '⚠️ Non sono riuscito a estrarre topic dal tuo messaggio. Riprova con più dettagli.');
        return;
      }

      // 2. Aggiungi ai topics esistenti
      const existing = readTopics();
      let nextId = getNextId(existing);

      const toAdd = newTopics.map(t => ({
        id:       nextId++,
        topic:    t.topic || 'Topic senza titolo',
        pilastro: t.pilastro || 'tecnico',
        photoId:  t.photoId || '',
        parlato:  t.parlato || '',
        note:     t.note || `Da Telegram: ${msg.text.slice(0, 50)}`,
        status:   'pending',
      }));

      const merged = [...existing, ...toAdd];
      saveTopics(merged);

      logger.info(`Telegram: ${toAdd.length} topic aggiunti da messaggio`);

      // 3. Conferma e mostra i topic creati
      const topicList = toAdd.map((t, i) =>
        `  ${i + 1}. <b>${t.topic}</b> [${t.pilastro}]${t.parlato ? ' 🎙️' : ''}`
      ).join('\n');

      bot.sendMessage(chatTarget, [
        `✅ <b>${toAdd.length} topic creati!</b>`,
        '',
        topicList,
        '',
        '🚀 Avvio il pipeline automaticamente...',
      ].join('\n'), { parse_mode: 'HTML' });

      // 4. Avvia pipeline per ogni topic pending
      const state = getState();
      if (state.status !== 'running') {
        onRunPipeline();
      } else {
        bot.sendMessage(chatTarget, '⏳ Pipeline già in esecuzione. I nuovi topic verranno processati al prossimo ciclo.');
      }

    } catch (err) {
      logger.error(`Telegram AI parse error: ${err.message}`);
      bot.sendMessage(chatTarget, `❌ Errore nell'analisi: ${err.message}\n\nRiprova o usa /topics per verificare la coda.`);
    }
  });

  // ─── Error handler (con backoff per evitare spam) ────────────────────────
  let _pollErrCount = 0;
  let _pollErrSuppressed = false;
  bot.on('polling_error', (err) => {
    _pollErrCount++;
    if (_pollErrCount === 1) {
      logger.error(`Telegram polling error: ${err.message}`);
    } else if (_pollErrCount === 5 && !_pollErrSuppressed) {
      _pollErrSuppressed = true;
      logger.warn('Telegram: rete non raggiungibile — polling in pausa, riprova ogni 30s (messaggi successivi soppressi)');
      // Ferma il polling aggressivo e riprova con intervallo lungo
      bot.stopPolling().then(() => {
        const retry = setInterval(() => {
          bot.startPolling().then(() => {
            _pollErrCount = 0;
            _pollErrSuppressed = false;
            clearInterval(retry);
            logger.info('Telegram: polling ripristinato');
          }).catch(() => {});
        }, 30_000);
      }).catch(() => {});
    }
  });

  return { bot, sendMessage, sendVideo };
}
