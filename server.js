/**
 * AvatarGenGioIA MCP — Web Dashboard Server
 * Interfaccia web moderna per il pipeline video Instagram
 *
 * Uso:  node server.js
 *       PORT=4000 node server.js
 */

import express from 'express';
import { createServer } from 'http';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import multer from 'multer';

process.on('uncaughtException',  (err) => { console.error('[CRASH] uncaughtException:', err); });
process.on('unhandledRejection', (err) => { console.error('[CRASH] unhandledRejection:', err); });
import * as XLSX from 'xlsx';
import cron from 'node-cron';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { startTelegramBot } from './tools/telegram-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Persistent data directory ────────────────────────────────────────────────
// In locale: cartella del progetto. Su Railway: volume montato su /data
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (DATA_DIR !== __dirname) {
  [DATA_DIR, path.join(DATA_DIR,'logs'), path.join(DATA_DIR,'output'), path.join(DATA_DIR,'config')]
    .forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// ─── Topics Storage ──────────────────────────────────────────────────────────
const TOPICS_FILE = DATA_DIR !== __dirname
  ? path.join(DATA_DIR, 'topics.json')
  : path.join(__dirname, 'config', 'topics.json');
const upload      = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function readTopics() {
  if (!fs.existsSync(TOPICS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); }
  catch { return []; }
}

function saveTopics(topics) {
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2));
}

function updateTopicStatus(id, status) {
  const topics = readTopics();
  const item   = topics.find(t => t.id === id);
  if (item) { item.status = status; saveTopics(topics); }
}

// ─── Event Bus ───────────────────────────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(100);

// ─── Pipeline State ──────────────────────────────────────────────────────────
let pipelineState = {
  status: 'idle',        // idle | running | success | error
  lastRun: null,
  lastResult: null,
  steps: [],
  cron: config.cron.schedule,
  env: config.isDev ? 'development' : 'production',
  keys: {
    heygen:    !!config.heygen.apiKey    && !config.heygen.apiKey.includes('...'),
    anthropic: !!config.anthropic.apiKey && !config.anthropic.apiKey.includes('...'),
    meta:      !!config.meta.accessToken && !config.meta.accessToken.includes('...'),
    topics:    true,
    telegram:  !!config.telegram.token && !config.telegram.token.includes('...'),
  },
};

function setState(patch) {
  pipelineState = { ...pipelineState, ...patch };
  bus.emit('state', pipelineState);
}

function setStep(name, status, detail = '') {
  const steps = [...pipelineState.steps];
  const idx = steps.findIndex(s => s.name === name);
  const step = { name, status, detail };
  if (idx >= 0) steps[idx] = step;
  else steps.push(step);
  setState({ steps });
}

// ─── Log File Watcher ────────────────────────────────────────────────────────
function getLogPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(__dirname, 'logs', `pipeline-${today}.log`);
}

function readLastLines(n = 200) {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return [];
  const content = fs.readFileSync(logPath, 'utf8');
  return content.split('\n').filter(Boolean).slice(-n);
}

let lastLogSize = 0;
function startLogWatcher() {
  const logPath = getLogPath();
  if (fs.existsSync(logPath)) lastLogSize = fs.statSync(logPath).size;

  setInterval(() => {
    const p = getLogPath();
    if (!fs.existsSync(p)) return;
    const { size } = fs.statSync(p);
    if (size > lastLogSize) {
      const fd  = fs.openSync(p, 'r');
      const buf = Buffer.alloc(size - lastLogSize);
      fs.readSync(fd, buf, 0, buf.length, lastLogSize);
      fs.closeSync(fd);
      lastLogSize = size;
      buf.toString().split('\n').filter(Boolean)
        .forEach(line => bus.emit('log', { line }));
    }
  }, 300);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────
async function runPipeline() {
  if (pipelineState.status === 'running') return;
  setState({ status: 'running', lastRun: new Date().toISOString(), steps: [], lastResult: null });
  logger.info('─── Avvio ciclo pipeline ───');

  let currentTopicId = null;

  try {
    // Step 1 — Topic
    setStep('Topic', 'running');
    const { selectTopic } = await import('./tools/select-topic.js');
    const item = await selectTopic();
    if (!item) {
      logger.warn('Nessun topic disponibile — pipeline saltata');
      setStep('Topic', 'skipped', 'Nessun topic disponibile');
      setState({ status: 'idle' });
      return;
    }
    setStep('Topic', 'done', item.topic);
    logger.info(`Topic: "${item.topic}" [${item.pilastro}]`);
    currentTopicId = item.id;

    // Step 2 — Script (usa parlato pre-scritto se presente, altrimenti Claude)
    setStep('Script', 'running');
    const { generateScript } = await import('./tools/generate-script.js');
    const script = await generateScript(item.topic, item.pilastro, item.parlato);
    const scriptSource = (item.parlato?.trim().length > 20) ? 'da Excel' : 'da Claude AI';
    setStep('Script', 'done', `${script.length} car. (${scriptSource})`);
    logger.info(`Script generato: ${script.length} caratteri (${scriptSource})`);

    // Step 3 — Video HeyGen
    setStep('Video HeyGen', 'running');
    const { createHeygenVideo } = await import('./tools/create-heygen-video.js');
    const videoUrl = await createHeygenVideo(script);
    setStep('Video HeyGen', 'done', 'URL ricevuto');
    logger.success(`Video: ${videoUrl}`);

    // Step 4 — Assembla Reel
    setStep('Assembla Reel', 'running');
    const { assembleReel } = await import('./tools/assemble-reel.js');
    const reelPath = await assembleReel(videoUrl, item.photoId, script);
    setStep('Assembla Reel', 'done', path.basename(reelPath));
    logger.success(`Reel: ${reelPath}`);

    // Step 5 — Invia su Telegram
    setStep('Invia Telegram', 'running');
    const caption = [
      `🪵 <b>${item.topic}</b>`,
      item.pilastro ? `🏷 ${item.pilastro}` : '',
      item.note     ? `📝 ${item.note}` : '',
    ].filter(Boolean).join('\n');
    await telegram.sendVideo(reelPath, caption);
    setStep('Invia Telegram', 'done', 'Inviato ✓');
    logger.success(`Telegram: video inviato (${path.basename(reelPath)})`);

    setState({ status: 'success', lastResult: reelPath });
    logger.success('Pipeline completata con successo!');
    if (currentTopicId) updateTopicStatus(currentTopicId, 'done');

  } catch (err) {
    logger.error(`Pipeline fallita: ${err.message}`);
    logger.error(err.stack);
    const running = pipelineState.steps.find(s => s.status === 'running');
    if (running) setStep(running.name, 'error', err.message.slice(0, 60));
    setState({ status: 'error', lastResult: err.message });
    if (currentTopicId) updateTopicStatus(currentTopicId, 'pending');
  }
}

// ─── Telegram Bot ────────────────────────────────────────────────────────────
const telegram = startTelegramBot(
  () => runPipelineAll(),   // callback per /run
  () => pipelineState,      // callback per /status
);

/**
 * Esegue il pipeline in loop per tutti i topic pending.
 * Dopo ogni video completato, invia il link su Telegram.
 * Al termine di tutti, invia un riepilogo finale.
 */
async function runPipelineAll() {
  const results = [];
  let processed = 0;

  while (true) {
    const topics = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'config', 'topics.json'), 'utf8'
    ).toString()).filter(t => t.status === 'pending');

    if (!topics.length) break;

    await runPipeline();
    processed++;

    // Raccogli risultato dell'ultimo run
    if (pipelineState.status === 'success' && pipelineState.lastResult) {
      const lastTopic = pipelineState.steps.find(s => s.name === 'Topic');
      results.push({
        topic: lastTopic?.detail || `Video #${processed}`,
        path:  pipelineState.lastResult,
      });

      // Notifica singolo video completato (il video è già stato inviato dallo step)
      telegram.sendMessage(
        `✅ <b>Video completato!</b>\n\n` +
        `📹 ${lastTopic?.detail || 'Video'}\n` +
        `📁 ${path.basename(pipelineState.lastResult)}`
      );
    } else if (pipelineState.status === 'error') {
      const lastTopic = pipelineState.steps.find(s => s.name === 'Topic');
      telegram.sendMessage(
        `❌ <b>Errore pipeline</b>\n\n` +
        `📹 ${lastTopic?.detail || 'Video'}\n` +
        `⚠️ ${pipelineState.lastResult || 'Errore sconosciuto'}`
      );
      break; // Interrompi in caso di errore
    }
  }

  // Riepilogo finale
  if (results.length > 0) {
    const lines = results.map((r, i) =>
      `  ${i + 1}. <b>${r.topic}</b>\n     📁 ${path.basename(r.path)}`
    ).join('\n\n');

    telegram.sendMessage(
      `🎬 <b>Pipeline completata!</b>\n\n` +
      `📊 ${results.length} video generati e inviati:\n\n${lines}`
    );
  } else if (processed === 0) {
    telegram.sendMessage('📭 Nessun topic pending da processare.');
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST API
app.get('/api/status', (_req, res) => res.json(pipelineState));

app.get('/api/logs', (_req, res) => res.json({ lines: readLastLines() }));

app.post('/api/run', (req, res) => {
  if (pipelineState.status === 'running') {
    return res.status(409).json({ error: 'Pipeline già in esecuzione' });
  }
  res.json({ ok: true });
  runPipelineAll();
});

// ─── Topics API ─────────────────────────────────────────────────────────────

// GET  /api/topics — legge topics.json
app.get('/api/topics', (_req, res) => res.json(readTopics()));

// POST /api/topics/upload — carica XLSX
app.post('/api/topics/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) return res.status(422).json({ error: 'Il file è vuoto' });

    const firstRow = rows[0];
    const missing  = ['topic', 'pilastro'].filter(k => !(k in firstRow));
    if (missing.length) {
      return res.status(422).json({ error: `Colonne obbligatorie mancanti: ${missing.join(', ')}` });
    }

    const topics = rows
      .map((r, i) => ({
        id:       i + 1,
        topic:    String(r.topic    || '').trim(),
        pilastro: String(r.pilastro || '').trim().toLowerCase(),
        photoId:  String(r.photoId  || r.photo_id || r.foto || '').trim(),
        parlato:  String(r.parlato  || '').trim(),
        note:     String(r.note     || '').trim(),
        status:   ['pending','done','skip'].includes(String(r.status).trim().toLowerCase())
                    ? String(r.status).trim().toLowerCase()
                    : 'pending',
      }))
      .filter(r => r.topic);

    saveTopics(topics);
    logger.info(`Topics importati: ${topics.length} righe da XLSX`);
    res.json({ ok: true, count: topics.length, topics });
  } catch (err) {
    logger.error(`Upload XLSX fallito: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/topics/:id — aggiorna status di un topic
app.patch('/api/topics/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const topics = readTopics();
  const idx    = topics.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Topic non trovato' });
  topics[idx]  = { ...topics[idx], ...req.body };
  saveTopics(topics);
  res.json(topics[idx]);
});

// DELETE /api/topics/:id — elimina un topic
app.delete('/api/topics/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const topics = readTopics().filter(t => t.id !== id);
  saveTopics(topics);
  res.json({ ok: true });
});

// ─── Config API ─────────────────────────────────────────────────────────────

const ENV_FILE            = path.join(__dirname, '.env');
const CONFIG_OVERRIDE_FILE = path.join(DATA_DIR, 'config-override.json');
const ENV_KNOWN_KEYS = [
  'HEYGEN_API_KEY','HEYGEN_AVATAR_ID','HEYGEN_VOICE_ID','HEYGEN_MOTION_ENGINE',
  'ANTHROPIC_API_KEY','ANTHROPIC_MODEL',
  'META_ACCESS_TOKEN','INSTAGRAM_ACCOUNT_ID',
  'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID',
  'CRON_SCHEDULE','PHOTOS_BASE_PATH',
];

function readEnvFile() {
  const map = {};
  // 1. process.env (Railway env vars o variabili di sistema)
  for (const k of ENV_KNOWN_KEYS) {
    if (process.env[k]) map[k] = process.env[k];
  }
  // 2. File .env locale (sovrascrive process.env per sviluppo locale)
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  // 3. Config override persistente su volume /data (sovrascrive tutto)
  if (fs.existsSync(CONFIG_OVERRIDE_FILE)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(CONFIG_OVERRIDE_FILE, 'utf8'));
      Object.assign(map, overrides);
    } catch {}
  }
  return map;
}

function writeEnvFile(vars) {
  if (process.env.RAILWAY_ENVIRONMENT_NAME) {
    // Su Railway: salva nel file di override persistente su volume
    const existing = fs.existsSync(CONFIG_OVERRIDE_FILE)
      ? JSON.parse(fs.readFileSync(CONFIG_OVERRIDE_FILE, 'utf8'))
      : {};
    fs.writeFileSync(CONFIG_OVERRIDE_FILE, JSON.stringify({ ...existing, ...vars }, null, 2));
  } else {
    // In locale: aggiorna .env
    const existing = readEnvFile();
    const merged   = { ...existing, ...vars };
    const content  = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(ENV_FILE, content);
  }
}

function maskKey(val) {
  if (!val || val.includes('...') || val.length < 6) return '';
  return val.slice(0, 4) + '••••••••' + val.slice(-4);
}

// GET /api/config — restituisce config corrente (chiavi mascherate)
app.get('/api/config', (_req, res) => {
  const env = readEnvFile();
  res.json({
    HEYGEN_API_KEY:       maskKey(env.HEYGEN_API_KEY),
    HEYGEN_AVATAR_ID:     env.HEYGEN_AVATAR_ID       || '',
    HEYGEN_VOICE_ID:      env.HEYGEN_VOICE_ID        || '',
    HEYGEN_MOTION_ENGINE: env.HEYGEN_MOTION_ENGINE   || '3',
    ANTHROPIC_API_KEY:    maskKey(env.ANTHROPIC_API_KEY),
    ANTHROPIC_MODEL:      env.ANTHROPIC_MODEL        || 'claude-sonnet-4-20250514',
    META_ACCESS_TOKEN:    maskKey(env.META_ACCESS_TOKEN),
    INSTAGRAM_ACCOUNT_ID: env.INSTAGRAM_ACCOUNT_ID  || '',
    TELEGRAM_BOT_TOKEN:   maskKey(env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID:     env.TELEGRAM_CHAT_ID       || '',
    CRON_SCHEDULE:        env.CRON_SCHEDULE          || '30 9 * * 1,3,5',
    PHOTOS_BASE_PATH:     env.PHOTOS_BASE_PATH       || './assets/photos',
    // flags di presenza (senza mascheratura)
    _has: {
      heygenKey:      !!(env.HEYGEN_API_KEY     && !env.HEYGEN_API_KEY.includes('...')),
      anthropicKey:   !!(env.ANTHROPIC_API_KEY  && !env.ANTHROPIC_API_KEY.includes('...')),
      metaToken:      !!(env.META_ACCESS_TOKEN  && !env.META_ACCESS_TOKEN.includes('...')),
      telegramToken:  !!(env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('...')),
    },
  });
});

// POST /api/config — salva variabili nel .env (solo le non-vuote inviate)
app.post('/api/config', (req, res) => {
  try {
    const allowed = [
      'HEYGEN_API_KEY','HEYGEN_AVATAR_ID','HEYGEN_VOICE_ID','HEYGEN_MOTION_ENGINE',
      'ANTHROPIC_API_KEY','ANTHROPIC_MODEL',
      'META_ACCESS_TOKEN','INSTAGRAM_ACCOUNT_ID',
      'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID',
      'CRON_SCHEDULE','PHOTOS_BASE_PATH',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== '' && !String(req.body[key]).includes('••••')) {
        patch[key] = String(req.body[key]).trim();
      }
    }
    if (!Object.keys(patch).length) return res.json({ ok: true, saved: 0 });
    writeEnvFile(patch);
    logger.info(`Config aggiornata: ${Object.keys(patch).join(', ')}`);
    res.json({ ok: true, saved: Object.keys(patch).length, keys: Object.keys(patch) });
  } catch(err) {
    logger.error(`Salvataggio config fallito: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/heygen/avatars — lista avatar disponibili
app.get('/api/heygen/avatars', async (_req, res) => {
  try {
    const env    = readEnvFile();
    const apiKey = env.HEYGEN_API_KEY;
    if (!apiKey || apiKey.includes('...')) {
      return res.status(400).json({ error: 'HEYGEN_API_KEY non configurata' });
    }
    const { default: axios } = await import('axios');
    const resp = await axios.get('https://api.heygen.com/v2/avatars', {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      timeout: 15000,
    });
    const avatars = (resp.data?.data?.avatars || resp.data?.avatars || []).map(a => ({
      avatar_id:   a.avatar_id   || a.id,
      avatar_name: a.avatar_name || a.name || a.avatar_id || a.id,
      preview_image_url: a.preview_image_url || a.thumbnail_url || null,
      gender:      a.gender      || '',
      premium:     !!a.is_premium,
      motion_mode: a.motion_mode || (a.is_premium ? '4' : '3'), // Avatar IV se premium, III altrimenti
    }));
    res.json({ ok: true, count: avatars.length, avatars });
  } catch(err) {
    logger.error(`HeyGen avatars: ${err.message}`);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// GET /api/heygen/voices — lista voci disponibili
app.get('/api/heygen/voices', async (_req, res) => {
  try {
    const env    = readEnvFile();
    const apiKey = env.HEYGEN_API_KEY;
    if (!apiKey || apiKey.includes('...')) {
      return res.status(400).json({ error: 'HEYGEN_API_KEY non configurata' });
    }
    const { default: axios } = await import('axios');
    const resp = await axios.get('https://api.heygen.com/v2/voices', {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      timeout: 15000,
    });
    const voices = (resp.data?.data?.voices || resp.data?.voices || []).map(v => ({
      voice_id:    v.voice_id    || v.id,
      display_name: v.display_name || v.name || v.voice_id || v.id,
      language:    v.language    || v.locale || '',
      gender:      v.gender      || '',
      preview_audio: v.preview_audio || null,
    }));
    res.json({ ok: true, count: voices.length, voices });
  } catch(err) {
    logger.error(`HeyGen voices: ${err.message}`);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── Wizard API ─────────────────────────────────────────────────────────────

const WIZARD_SYSTEM_PROMPT = `Sei l'assistente AI di 2C Legnami, fornitore di legna da ardere per pizzerie professionali.
Il tuo compito è generare una lista di topic per video Instagram Reel, basandoti sulle risposte di un questionario.

Genera ESATTAMENTE il numero di topic richiesto (campo "qty").
Per ogni topic produci un oggetto JSON con questi campi:
- "topic": titolo video (max 65 caratteri, incisivo e chiaro)
- "pilastro": uno tra "tecnico","prodotto","servizio","brand" (se qty è "misto" varia)
- "photoId": suggerisci un nome file immagine coerente (es. "faggio_01.jpg") o ""
- "parlato": se nel questionario ci sono testi base, adattali e completali per questo topic (max 300 caratteri). Altrimenti lascia "" (verrà generato da Claude al momento del video)
- "note": breve nota contestuale sull'argomento

REGOLE:
- I topic devono essere DIVERSI tra loro e coprire angolazioni diverse dello stesso argomento
- Rispetta stile, target e CTA indicati nel questionario
- Se pilastro è "misto", distribuisci equamente tra i 4 pilastri
- Rispondi SOLO con un array JSON valido, nessun testo aggiuntivo, nessun markdown`;

// POST /api/wizard/generate — Claude genera i topic dal questionario
app.post('/api/wizard/generate', async (req, res) => {
  try {
    const env    = readEnvFile();
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY non configurata' });

    const answers = req.body;
    const qty     = parseInt(answers.qty) || 5;

    const userMessage = `Questionario compilato:
- Numero di video: ${qty}
- Argomento principale: ${answers.subject || 'legna da ardere per pizzerie'}
- Pilastro: ${answers.pilastro || 'misto'}
- Pubblico target: ${answers.target || 'pizzaioli professionali'}
- Stile comunicativo: ${answers.stile || 'educativo'}
- Prodotto specifico: ${answers.prodotto || 'nessuno'}
- Messaggio chiave: ${answers.messaggio || ''}
- Testi base già scritti: ${answers.parlato || 'nessuno — Claude genererà tutto'}
- Call-to-action: ${answers.cta || 'contattaci'}
- Note aggiuntive: ${answers.note || 'nessuna'}

Genera esattamente ${qty} topic diversi tra loro.`;

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: WIZARD_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text      = response.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Claude non ha restituito un JSON valido');

    let topics = JSON.parse(jsonMatch[0]);
    // Normalizza e assegna id progressivi
    topics = topics.slice(0, qty).map((t, i) => ({
      id:       i + 1,
      topic:    String(t.topic    || '').trim(),
      pilastro: String(t.pilastro || 'tecnico').trim().toLowerCase(),
      photoId:  String(t.photoId  || '').trim(),
      parlato:  String(t.parlato  || '').trim(),
      note:     String(t.note     || '').trim(),
      status:   'pending',
    })).filter(t => t.topic);

    logger.info(`Wizard: generati ${topics.length} topic con Claude`);
    res.json({ ok: true, count: topics.length, topics });
  } catch (err) {
    logger.error(`Wizard generate: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wizard/export-xlsx — scarica i topic generati come file Excel
app.post('/api/wizard/export-xlsx', (req, res) => {
  try {
    const { topics } = req.body;
    if (!topics?.length) return res.status(400).json({ error: 'Nessun topic fornito' });

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
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="2c-legnami-topics-wizard.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wizard/import — importa direttamente i topic generati nella pipeline
app.post('/api/wizard/import', (req, res) => {
  try {
    const { topics } = req.body;
    if (!topics?.length) return res.status(400).json({ error: 'Nessun topic fornito' });
    const existing = readTopics();
    const maxId    = existing.length ? Math.max(...existing.map(t => t.id)) : 0;
    const toAdd    = topics.map((t, i) => ({ ...t, id: maxId + i + 1, status: 'pending' }));
    saveTopics([...existing, ...toAdd]);
    logger.info(`Wizard import: ${toAdd.length} topic aggiunti`);
    res.json({ ok: true, count: toAdd.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/topics/template — scarica template XLSX precompilato
app.get('/api/topics/template', (_req, res) => {
  const data = [
    {
      topic:    'essiccazione naturale vs forno',
      pilastro: 'tecnico',
      photoId:  'foto_001.jpg',
      parlato:  'La legna umida crea variazioni di temperatura nel forno. Ogni nostro lotto viene testato con igrometro: umidità residua sotto il 20%. Il forno lavora in modo costante. Se vuoi provare la nostra legna, contattaci.',
      note:     'Confronto metodi',
      status:   'pending',
    },
    {
      topic:    'perché scegliere il Faggio Premium per pizza napoletana',
      pilastro: 'prodotto',
      photoId:  'faggio_01.jpg',
      parlato:  '',
      note:     'Lascia vuoto: Claude genera il testo automaticamente',
      status:   'pending',
    },
    {
      topic:    'consegna 24h e stabilità del servizio',
      pilastro: 'servizio',
      photoId:  'consegna.jpg',
      parlato:  '',
      note:     'Alta stagione estiva',
      status:   'pending',
    },
    {
      topic:    'chi siamo: 3 generazioni di esperienza',
      pilastro: 'brand',
      photoId:  'team.jpg',
      parlato:  '',
      note:     '',
      status:   'pending',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 52 }, { wch: 12 }, { wch: 20 }, { wch: 80 }, { wch: 30 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Topics');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="2c-legnami-topics-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// SSE — real-time events stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const onState = s => send('state', s);
  const onLog   = l => send('log',   l);

  bus.on('state', onState);
  bus.on('log',   onLog);

  // Invia stato corrente subito
  send('state', pipelineState);

  // Keepalive ogni 20s
  const ka = setInterval(() => res.write(':ka\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(ka);
    bus.off('state', onState);
    bus.off('log',   onLog);
  });
});

// ─── Avvio ───────────────────────────────────────────────────────────────────
logger.info('══════════════════════════════════════');
logger.info('  AvatarGenGioIA — MCP WEB DASHBOARD');
logger.info('══════════════════════════════════════');
logger.info(`Ambiente: ${config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
logger.info(`Schedule: ${config.cron.schedule}`);

// Cron scheduler
cron.schedule(config.cron.schedule, () => {
  logger.info(`Cron triggered: ${new Date().toISOString()}`);
  telegram.sendMessage('⏰ <b>Cron attivato</b> — avvio pipeline automatico...');
  runPipelineAll();
}, { timezone: 'Europe/Rome' });

// Avvia log watcher
startLogWatcher();

// Avvia HTTP server
const PORT = process.env.PORT || 3333;
createServer(app).listen(PORT, () => {
  logger.info(`Dashboard: http://localhost:${PORT}`);
  // Apre browser automaticamente su Windows
  import('child_process').then(({ exec }) => {
    exec(`start http://localhost:${PORT}`);
  });
});

logger.info(`Scheduler attivo: ${config.cron.schedule} (Europe/Rome)`);
logger.info('Premi Ctrl+C per fermare.');
