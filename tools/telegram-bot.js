/**
 * TELEGRAM BOT — AvatarGenGioIA MCP
 *
 * Comandi:
 *   /start        — Messaggio di benvenuto
 *   /status       — Stato corrente del pipeline
 *   /topics       — Lista dei topics in coda
 *   /run          — Forza esecuzione pipeline
 *   /wizard       — Avvia il questionario per generare Excel + importare topics
 *   /annulla      — Annulla wizard in corso
 *   (testo libero) — Viene processato dall'AI per creare topics velocemente
 */

import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';
import * as XLSX   from 'xlsx';
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

// ─── Wizard: definizione domande ─────────────────────────────────────────────

const WIZARD_QUESTIONS = [
  {
    key:         'qty',
    label:       'Quanti video vuoi generare?',
    hint:        '(es. 5, 10, 20)',
    required:    true,
    validate:    v => parseInt(v) > 0 ? null : 'Inserisci un numero valido maggiore di 0',
    transform:   v => parseInt(v),
  },
  {
    key:         'subject',
    label:       "Qual è l'argomento principale?",
    hint:        '(es. Intelligenza Artificiale, Marketing, Cucina italiana, Fitness...)',
    required:    true,
  },
  {
    key:         'pilastro',
    label:       'Che tipo di contenuto vuoi?',
    hint:        'educativo / opinione / tutorial / ispirazione / notizia / brand / misto',
    required:    false,
    default:     'misto',
  },
  {
    key:         'target',
    label:       'Chi è il tuo pubblico target?',
    hint:        '(es. imprenditori 30-45 anni, giovani appassionati di tech, mamme...) — lascia vuoto per saltare',
    required:    false,
    default:     '',
  },
  {
    key:         'stile',
    label:       'Che stile comunicativo preferisci?',
    hint:        'serio / ironico / motivazionale / informativo / storytelling — lascia vuoto per saltare',
    required:    false,
    default:     'informativo',
  },
  {
    key:         'messaggio',
    label:       'Qual è il messaggio chiave che vuoi trasmettere?',
    hint:        '(es. "l\'AI aiuta chiunque a lavorare meglio") — lascia vuoto per saltare',
    required:    false,
    default:     '',
  },
  {
    key:         'cta',
    label:       'Vuoi una call-to-action specifica?',
    hint:        '(es. "seguimi per altri video", "commenta cosa ne pensi") — lascia vuoto per saltare',
    required:    false,
    default:     '',
  },
  {
    key:         'parlato',
    label:       'Hai già dei testi scritti da usare?',
    hint:        'Incollali qui se li hai, altrimenti scrivi "no" e li genera Gemini automaticamente',
    required:    false,
    default:     '',
    transform:   v => (v.toLowerCase() === 'no' || v.toLowerCase() === 'n') ? '' : v,
  },
  {
    key:         'note',
    label:       'Note aggiuntive o istruzioni speciali?',
    hint:        '(tono, formato, lunghezza, lingua...) — scrivi "no" per saltare',
    required:    false,
    default:     '',
    transform:   v => (v.toLowerCase() === 'no' || v.toLowerCase() === 'n') ? '' : v,
  },
];

// ─── Wizard: genera topics con Claude ────────────────────────────────────────

const WIZARD_SYSTEM_PROMPT = `Sei un esperto stratega di contenuti video per social media.
Genera ESATTAMENTE il numero di topic richiesto (campo "qty").
Per ogni topic produci un oggetto JSON con:
- "topic": titolo del video (max 65 caratteri, incisivo, curioso, adatto ai social)
- "pilastro": categoria coerente con l'argomento (educativo/opinione/tutorial/ispirazione/notizia/brand)
- "photoId": nome file immagine descrittivo (es. "ai_futuro_01.jpg") o ""
- "parlato": se ci sono testi base nel questionario adattali (max 300 car.), altrimenti ""
- "note": breve nota sull'angolazione del video
REGOLE: topic diversi tra loro, linguaggio adatto al target, rispondi SOLO con array JSON valido.`;

async function generateTopicsWithGemini(answers) {
  const apiKey = process.env.GEMINI_API_KEY || config.gemini?.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY mancante');

  const qty = parseInt(answers.qty) || 5;
  const userMessage = `Questionario compilato:
- Numero di video: ${qty}
- Argomento principale: ${answers.subject || 'non specificato'}
- Tipo di contenuto: ${answers.pilastro || 'misto'}
- Pubblico target: ${answers.target || 'non specificato'}
- Stile comunicativo: ${answers.stile || 'informativo'}
- Messaggio chiave: ${answers.messaggio || 'non specificato'}
- Call-to-action: ${answers.cta || 'nessuna'}
- Testi base: ${answers.parlato || 'nessuno — genera tutto tu'}
- Note: ${answers.note || 'nessuna'}

Genera esattamente ${qty} topic diversi.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model  = genAI.getGenerativeModel({
    model:             process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    systemInstruction: WIZARD_SYSTEM_PROMPT,
  });
  const result = await model.generateContent(userMessage);
  const text   = result.response.text().trim();

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Gemini non ha restituito JSON valido');

  const topics = JSON.parse(jsonMatch[0]);
  return topics.slice(0, qty).map((t, i) => ({
    id:       i + 1,
    topic:    String(t.topic    || '').trim(),
    pilastro: String(t.pilastro || 'educativo').trim().toLowerCase(),
    photoId:  String(t.photoId  || '').trim(),
    parlato:  String(t.parlato  || '').trim(),
    note:     String(t.note     || '').trim(),
    status:   'pending',
  })).filter(t => t.topic);
}

// ─── Wizard: genera file Excel in memoria ─────────────────────────────────────

function generateExcelBuffer(topics) {
  const data = topics.map(t => ({
    topic:    t.topic,
    pilastro: t.pilastro,
    photoId:  t.photoId  || '',
    parlato:  t.parlato  || '',
    note:     t.note     || '',
    status:   'pending',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 60 }, { wch: 12 }, { wch: 20 }, { wch: 80 }, { wch: 30 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Topics');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Claude AI: analizza messaggio libero e genera topics ────────────────────

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
  const apiKey = process.env.GEMINI_API_KEY || config.gemini?.apiKey;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY mancante — impossibile analizzare il messaggio');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model  = genAI.getGenerativeModel({
    model:             process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    systemInstruction: PARSE_SYSTEM_PROMPT,
  });
  const result = await model.generateContent(userMessage);
  const text   = result.response.text().trim();

  // Estrai JSON dall'output (potrebbe avere backtick markdown)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Gemini non ha restituito un JSON valido: ${text.slice(0, 200)}`);
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
export function startTelegramBot(onRunPipeline, getState, readTopicsCallback = null, saveTopicsCallback = null, onImportHistory = null, onLogMessage = null) {
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

  // Usa i callback del server per leggere/scrivere topics (multi-tenant)
  const readT = () => readTopicsCallback ? readTopicsCallback() : readTopics();
  const saveT = (t) => saveTopicsCallback ? saveTopicsCallback(t) : saveTopics(t);

  // ─── Sessioni wizard (una per chat_id) ───────────────────────────────────
  // { [chatId]: { step: 0, answers: {} } }
  const wizardSessions = {};

  // Sessioni di conferma post-wizard: { [chatId]: { tmpPath, topics } }
  // Attivo tra l'invio della domanda "sì/no" e la risposta dell'utente.
  const confirmSessions = {};

  function isInWizard(id) { return !!wizardSessions[id]; }

  function startWizard(id) {
    wizardSessions[id] = { step: 0, answers: {} };
  }

  function cancelWizard(id) {
    delete wizardSessions[id];
  }

  // Invia la prossima domanda del wizard
  function askNextQuestion(chatTarget, id) {
    const session = wizardSessions[id];
    if (!session) return;

    const q = WIZARD_QUESTIONS[session.step];
    const progress = `[${session.step + 1}/${WIZARD_QUESTIONS.length}]`;
    const skipNote = !q.required ? '\n<i>Lascia vuoto (invia "-") per saltare</i>' : '';

    bot.sendMessage(chatTarget,
      `${progress} <b>${q.label}</b>\n<i>${q.hint}</i>${skipNote}`,
      { parse_mode: 'HTML' }
    );
  }

  // Utility: invia messaggio al chat autorizzato
  function sendMessage(text, options = {}) {
    const target = chatId || null;
    if (!target) { logger.warn('TELEGRAM_CHAT_ID non configurato'); return; }
    return bot.sendMessage(target, text, { parse_mode: 'HTML', ...options });
  }

  // Utility: invia file video al chat autorizzato
  function sendVideo(filePath, caption = '', options = {}) {
    const target = chatId || null;
    if (!target) { logger.warn('TELEGRAM_CHAT_ID non configurato'); return Promise.resolve(); }
    logger.info(`Telegram: invio video → ${filePath}`);
    return bot.sendVideo(target, filePath, { caption, parse_mode: 'HTML', supports_streaming: true, ...options })
      .catch(err => { logger.error(`Telegram sendVideo error: ${err.message}`); });
  }

  // Controllo autorizzazione
  function isAuthorized(msg) {
    if (!chatId) return true;
    return String(msg.chat.id) === String(chatId);
  }

  // ─── Conversation logging ─────────────────────────────────────────────────
  function logMsg(dir, text) {
    if (!onLogMessage) return;
    try {
      const clean = String(text).replace(/<[^>]*>/g, '').trim();
      if (clean) onLogMessage({ dir, text: clean, ts: new Date().toISOString() });
    } catch {}
  }

  // Avvolge bot.sendMessage per loggare automaticamente tutti i messaggi in uscita
  const _origSendMsg = bot.sendMessage.bind(bot);
  bot.sendMessage = (cid, text, opts) => {
    logMsg('out', text);
    return _origSendMsg(cid, text, opts);
  };

  // Logga tutti i messaggi in arrivo (comandi + testo libero)
  bot.on('message', (msg) => {
    if (!isAuthorized(msg)) return;
    const text = msg.text?.trim();
    if (text) logMsg('in', text);
  });

  // ─── /start ──────────────────────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(msg.chat.id, [
      '🎬 <b>AvatarGenGioIA — Video Pipeline Bot</b>',
      '',
      '<b>Comandi disponibili:</b>',
      '/wizard — 📋 Questionario guidato per generare Excel + topic',
      '/run — 🚀 Avvia la pipeline sui topic in coda',
      '/topics — 📋 Lista topic in coda',
      '/status — 📊 Stato pipeline',
      '/annulla — ❌ Annulla wizard in corso',
      '',
      '💡 Oppure scrivimi direttamente un argomento per creare topic al volo:',
      '<i>"fai 3 video sull\'intelligenza artificiale nel lavoro"</i>',
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /wizard — avvia il questionario guidato ─────────────────────────────
  bot.onText(/\/wizard/, (msg) => {
    if (!isAuthorized(msg)) return;
    const id = msg.chat.id;

    if (isInWizard(id)) {
      bot.sendMessage(id, '⚠️ Hai già un wizard in corso.\nRispondi alla domanda oppure usa /annulla per ricominciare.');
      return;
    }

    // Se c'era una conferma pendente, puliscila silenziosamente
    delete confirmSessions[id];

    startWizard(id);
    bot.sendMessage(id, [
      '📋 <b>Wizard Creazione Topic</b>',
      '',
      'Ti farò alcune domande per capire cosa creare.',
      'Al termine genererò i topic con Claude AI e ti invierò il file Excel pronto da importare.',
      '',
      'Rispondi "-" per saltare le domande opzionali.',
      'Usa /annulla in qualsiasi momento per interrompere.',
      '',
      '🚀 Iniziamo!',
    ].join('\n'), { parse_mode: 'HTML' });

    setTimeout(() => askNextQuestion(id, id), 600);
  });

  // ─── /annulla — cancella wizard in corso ─────────────────────────────────
  bot.onText(/\/annulla/, (msg) => {
    if (!isAuthorized(msg)) return;
    const id = msg.chat.id;
    const hasPendingConfirm = !!confirmSessions[id];
    delete confirmSessions[id]; // cancella anche eventuale conferma pendente
    if (isInWizard(id)) {
      cancelWizard(id);
      bot.sendMessage(id, '❌ Wizard annullato. Usa /wizard per ricominciare.');
    } else if (hasPendingConfirm) {
      bot.sendMessage(id, '❌ Importazione annullata. Usa /wizard per ricominciare.');
    } else {
      bot.sendMessage(id, 'Nessun wizard in corso.');
    }
  });

  // ─── /status ─────────────────────────────────────────────────────────────
  bot.onText(/\/status/, (msg) => {
    if (!isAuthorized(msg)) return;
    const state = getState();
    const statusEmoji = { idle: '⏸️', running: '🔄', success: '✅', error: '❌' }[state.status] || '❓';
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
      state.lastResult ? `\n📎 Risultato: ${state.lastResult}` : '',
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /topics ─────────────────────────────────────────────────────────────
  bot.onText(/\/topics/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const topics = await readT();
    if (!topics.length) {
      bot.sendMessage(msg.chat.id, '📭 Nessun topic in coda.\nUsa /wizard per crearne!');
      return;
    }
    const statusEmoji = { pending: '🟡', 'in-progress': '🔄', done: '✅', skip: '⏭️', error: '❌' };
    const lines = topics.map(t =>
      `${statusEmoji[t.status] || '⬜'} <b>${t.topic}</b>\n   [${t.pilastro}]${t.parlato ? ' 🎙️' : ''}`
    );
    bot.sendMessage(msg.chat.id, [
      `📋 <b>Topics in coda (${topics.length})</b>`,
      `🟡 pending: ${topics.filter(t => t.status === 'pending').length}  ✅ done: ${topics.filter(t => t.status === 'done').length}`,
      '',
      ...lines.slice(0, 20),
      topics.length > 20 ? `\n… e altri ${topics.length - 20} topic` : '',
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // ─── /run ────────────────────────────────────────────────────────────────
  bot.onText(/\/run/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const state = getState();
    if (state.status === 'running') {
      bot.sendMessage(msg.chat.id, '⚠️ Pipeline già in esecuzione.');
      return;
    }
    const pending = (await readT()).filter(t => t.status === 'pending').length;
    if (!pending) {
      bot.sendMessage(msg.chat.id, '📭 Nessun topic pending. Usa /wizard per crearne.');
      return;
    }
    bot.sendMessage(msg.chat.id, `✅ Ricevuto! Avvio la pipeline per <b>${pending}</b> topic...`, { parse_mode: 'HTML' });
    onRunPipeline();
  });

  // ─── Messaggi in arrivo ───────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return;
    if (!msg.text?.trim()) return;
    if (!isAuthorized(msg)) return;

    const id   = msg.chat.id;
    const text = msg.text.trim();

    // ── Gestione risposta conferma wizard (si/no testuale) ─────────────────
    if (confirmSessions[id]) {
      const { tmpPath, topics } = confirmSessions[id];
      const lower = text.toLowerCase().trim();
      const isYes = ['si','s\u00ec','s\u00ec','yes','y','ok','certo','vai','avvia','importa'].includes(lower);
      const isNo  = ['no','n','skip','annulla','cancel','nope'].includes(lower);

      if (isYes) {
        delete confirmSessions[id];
        try {
          const existing = await readT();
          let nextId = getNextId(existing);
          const toAdd = topics.map(t => ({ ...t, id: nextId++, status: 'pending' })).filter(t => t.topic);
          await saveT([...existing, ...toAdd]);
          if (onImportHistory) await onImportHistory(toAdd, 'telegram-wizard').catch(() => {});
          logger.info(`Wizard confirm (testo): ${toAdd.length} topic importati`);
          bot.sendMessage(id, [
            `\u2705 <b>${toAdd.length} topic importati!</b>`,
            '',
            '\ud83d\ude80 Avvio la pipeline...',
          ].join('\n'), { parse_mode: 'HTML' });
          const state = getState();
          if (state.status !== 'running') onRunPipeline();
        } catch (err) {
          bot.sendMessage(id, `\u274c Errore importazione: ${err.message}`);
        }
        return;
      }

      if (isNo) {
        delete confirmSessions[id];
        bot.sendMessage(id, '\ud83d\udc4d Ok! Puoi importare il file Excel manualmente dalla dashboard.\nUsa /run quando sei pronto.');
        return;
      }

      // Risposta non riconosciuta — rimanda la domanda
      bot.sendMessage(id, '\u2753 Rispondi <b>s\u00ec</b> per importare e avviare, oppure <b>no</b> per tenere solo il file Excel.', { parse_mode: 'HTML' });
      return;
    }

    // ── Gestione risposta wizard ──────────────────────────────────────────
    if (isInWizard(id)) {
      const session = wizardSessions[id];
      const q       = WIZARD_QUESTIONS[session.step];

      // Valore: "-" o vuoto → usa default
      let value = (text === '-' || text === '') ? (q.default ?? '') : text;

      // Validazione
      if (q.validate) {
        const err = q.validate(value);
        if (err) {
          bot.sendMessage(id, `⚠️ ${err}`);
          return; // Rilancia stessa domanda
        }
      }

      // Trasformazione
      if (q.transform) value = q.transform(value);

      session.answers[q.key] = value;
      session.step++;

      // Domande finite?
      if (session.step >= WIZARD_QUESTIONS.length) {
        const answers = { ...session.answers };
        cancelWizard(id);

        bot.sendMessage(id, [
          '✅ <b>Questionario completato!</b>',
          '',
          `📌 Argomento: <b>${answers.subject}</b>`,
          `🎬 Video da generare: <b>${answers.qty}</b>`,
          `🏷 Tipo: ${answers.pilastro || 'misto'}`,
          `👥 Target: ${answers.target || '—'}`,
          '',
          '🧠 Sto generando i topic con Gemini AI...',
        ].join('\n'), { parse_mode: 'HTML' });

        try {
          // Genera topics con Gemini
          const topics = await generateTopicsWithGemini(answers);

          // Genera Excel
          const xlsxBuffer = generateExcelBuffer(topics);
          const tmpPath = path.join(__dirname, `../assets/output/wizard-${Date.now()}.xlsx`);
          fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
          fs.writeFileSync(tmpPath, xlsxBuffer);

          // Invia riepilogo topic
          const topicList = topics.slice(0, 10).map((t, i) =>
            `  ${i + 1}. <b>${t.topic}</b> [${t.pilastro}]`
          ).join('\n');

          await bot.sendMessage(id, [
            `🎯 <b>${topics.length} topic generati!</b>`,
            '',
            topicList,
            topics.length > 10 ? `\n  … e altri ${topics.length - 10}` : '',
            '',
            '📤 Ti invio il file Excel...',
          ].join('\n'), { parse_mode: 'HTML' });

          // Invia file Excel
          await bot.sendDocument(id, tmpPath, {
            caption: `📊 <b>topics-wizard.xlsx</b> — ${topics.length} topic pronti da importare nella dashboard`,
            parse_mode: 'HTML',
          });

          // Chiedi se importare e avviare subito
          await bot.sendMessage(id,
            '🚀 Vuoi importare questi topic nella pipeline e avviarla subito?\nRispondi <b>s\u00ec</b> o <b>no</b> (oppure usa i bottoni).',
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '\u2705 S\u00ec, importa e avvia', callback_data: `wizard_import:${tmpPath}` },
                  { text: '\u274c No, solo Excel', callback_data: 'wizard_skip' },
                ]],
              },
            }
          );

          // Salva sessione di conferma per gestire risposta testuale
          confirmSessions[id] = { tmpPath, topics };

          // Cleanup file dopo 10 minuti
          setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 10 * 60 * 1000);

          logger.info(`Wizard Telegram: ${topics.length} topic generati per chat ${id}`);

        } catch (err) {
          logger.error(`Wizard Telegram error: ${err.message}`);
          bot.sendMessage(id, `❌ Errore nella generazione: ${err.message}\n\nUsa /wizard per riprovare.`);
        }

        return;
      }

      // Prossima domanda
      askNextQuestion(id, id);
      return;
    }

    // ── Messaggio libero → crea topic veloce ─────────────────────────────
    try {
      bot.sendMessage(id, '🧠 Analizzo il tuo messaggio con Gemini AI...');

      const newTopics = await parseMessageWithAI(text);
      if (!newTopics.length) {
        bot.sendMessage(id, '⚠️ Non sono riuscito a estrarre topic. Prova con più dettagli o usa /wizard.');
        return;
      }

      const existing = await readT();
      let nextId = getNextId(existing);
      const toAdd = newTopics.map(t => ({
        id:       nextId++,
        topic:    t.topic || 'Topic senza titolo',
        pilastro: t.pilastro || 'educativo',
        photoId:  t.photoId || '',
        parlato:  t.parlato || '',
        note:     t.note || `Da Telegram: ${text.slice(0, 50)}`,
        status:   'pending',
      }));

      await saveT([...existing, ...toAdd]);
      if (onImportHistory) await onImportHistory(toAdd, 'telegram').catch(() => {});
      logger.info(`Telegram: ${toAdd.length} topic aggiunti da messaggio libero`);

      const topicList = toAdd.map((t, i) =>
        `  ${i + 1}. <b>${t.topic}</b> [${t.pilastro}]`
      ).join('\n');

      bot.sendMessage(id, [
        `✅ <b>${toAdd.length} topic aggiunti!</b>`,
        '',
        topicList,
        '',
        '🚀 Avvio il pipeline automaticamente...',
      ].join('\n'), { parse_mode: 'HTML' });

      const state = getState();
      if (state.status !== 'running') {
        onRunPipeline();
      } else {
        bot.sendMessage(id, '⏳ Pipeline già in esecuzione. I topic verranno processati al prossimo ciclo.');
      }

    } catch (err) {
      logger.error(`Telegram AI parse error: ${err.message}`);
      bot.sendMessage(id, `❌ Errore: ${err.message}`);
    }
  });

  // ─── Callback inline keyboard (bottoni wizard) ───────────────────────────
  bot.on('callback_query', async (query) => {
    const id   = query.message.chat.id;
    const data = query.data;

    bot.answerCallbackQuery(query.id);
    delete confirmSessions[id]; // pulisce eventuale sessione di conferma testuale

    if (data.startsWith('wizard_import:')) {
      const tmpPath = data.replace('wizard_import:', '');

      try {
        // Leggi Excel generato e importa topics
        const buf    = fs.readFileSync(tmpPath);
        const wb     = XLSX.read(buf, { type: 'buffer' });
        const ws     = wb.Sheets[wb.SheetNames[0]];
        const rows   = XLSX.utils.sheet_to_json(ws, { defval: '' });

        const existing = await readT();
        let nextId = getNextId(existing);
        const toAdd = rows.map(r => ({
          id:       nextId++,
          topic:    String(r.topic    || '').trim(),
          pilastro: String(r.pilastro || 'educativo').trim().toLowerCase(),
          photoId:  String(r.photoId  || '').trim(),
          parlato:  String(r.parlato  || '').trim(),
          note:     String(r.note     || '').trim(),
          status:   'pending',
        })).filter(r => r.topic);

        await saveT([...existing, ...toAdd]);
        if (onImportHistory) await onImportHistory(toAdd, 'telegram-wizard').catch(() => {});
        logger.info(`Wizard import: ${toAdd.length} topic importati da Telegram`);

        await bot.sendMessage(id, [
          `✅ <b>${toAdd.length} topic importati nella pipeline!</b>`,
          '',
          '🚀 Avvio la pipeline...',
        ].join('\n'), { parse_mode: 'HTML' });

        const state = getState();
        if (state.status !== 'running') {
          onRunPipeline();
        }

      } catch (err) {
        logger.error(`Wizard import callback error: ${err.message}`);
        bot.sendMessage(id, `❌ Errore nell'importazione: ${err.message}`);
      }

    } else if (data === 'wizard_skip') {
      bot.sendMessage(id, '👍 Ok! Puoi importare il file Excel manualmente dalla dashboard.\nUsa /run quando sei pronto ad avviare la pipeline.');
    }
  });

  // ─── Error handler ────────────────────────────────────────────────────────
  let _pollErrCount = 0;
  let _pollErrSuppressed = false;
  bot.on('polling_error', (err) => {
    _pollErrCount++;
    if (_pollErrCount === 1) {
      logger.error(`Telegram polling error: ${err.message}`);
    } else if (_pollErrCount === 5 && !_pollErrSuppressed) {
      _pollErrSuppressed = true;
      logger.warn('Telegram: rete non raggiungibile — riprovo ogni 30s');
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
