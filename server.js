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
import jwt    from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

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

// ─── Config Override ─────────────────────────────────────────────────────────
// Applica subito config-override.json a process.env (volume Railway /data)
// Questo garantisce che HEYGEN_ASPECT_RATIO e tutte le altre variabili
// impostate dalla dashboard siano corrette PRIMA che qualsiasi tool le legga.
const CONFIG_OVERRIDE_FILE = path.join(DATA_DIR, 'config-override.json');

// ─── Auth + Users ─────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'avatargen-jwt-secret-change-me';
const USERS_FILE = path.join(DATA_DIR !== __dirname ? DATA_DIR : __dirname, 'users.json');
const USERS_DIR  = path.join(DATA_DIR !== __dirname ? DATA_DIR : __dirname, 'users');

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function getUserDir(userId) {
  return path.join(USERS_DIR, String(userId));
}
function readUserConfig(userId) {
  const f = path.join(getUserDir(userId), 'config.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
function writeUserConfig(userId, vars) {
  const dir = getUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'config.json');
  const merged = { ...readUserConfig(userId), ...vars };
  fs.writeFileSync(f, JSON.stringify(merged, null, 2));
  for (const [k, v] of Object.entries(vars)) process.env[k] = String(v);
}
function readUserTopics(userId) {
  const f = path.join(getUserDir(userId), 'topics.json');
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function writeUserTopics(userId, topics) {
  const dir = getUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'topics.json'), JSON.stringify(topics, null, 2));
}
function getUserTopicsFile(userId) {
  return path.join(getUserDir(userId), 'topics.json');
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // L'admin può agire come un altro utente tramite header X-As-User
    const asUser = req.headers['x-as-user'];
    req.effectiveUserId = (req.user.role === 'admin' && asUser) ? asUser : req.user.id;
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Accesso negato — solo admin' });
  next();
}

// ─── Bootstrap Admin ─────────────────────────────────────────────────────────
async function bootstrapAdmin() {
  const users = readUsers();
  if (users.some(u => u.role === 'admin')) return;
  const email    = process.env.ADMIN_EMAIL    || 'admin@localhost';
  const password = process.env.ADMIN_PASSWORD || 'Admin1234!';
  const hash     = await bcrypt.hash(password, 10);
  const admin = { id: randomUUID(), email, name: 'Admin', passwordHash: hash,
                  role: 'admin', plan: 'unlimited', active: true, approved: true,
                  sections: ['pipeline','topics','wizard','config'],
                  createdAt: new Date().toISOString() };
  users.push(admin);
  writeUsers(users);
  // Migra config .env esistente al profilo admin
  const existingCfg = readEnvFile();
  if (Object.keys(existingCfg).length) writeUserConfig(admin.id, existingCfg);
  // Migra topics esistenti al profilo admin
  const existingTopics = readTopics();
  if (existingTopics.length) writeUserTopics(admin.id, existingTopics);
  logger.info(`👤 Admin creato: ${email} — password: ${password}  ← CAMBIA SU RAILWAY!`);
  console.info(`
🔑 PRIMO AVVIO — credenziali admin:
   Email:    ${email}
   Password: ${password}
   Cambia la password dopo il primo login!
`);
}
if (fs.existsSync(CONFIG_OVERRIDE_FILE)) {
  try {
    const _overrides = JSON.parse(fs.readFileSync(CONFIG_OVERRIDE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(_overrides)) process.env[k] = String(v);
    console.info(`[config] Override applicato all'avvio: ${Object.keys(_overrides).join(', ')}`);
  } catch (e) {
    console.warn(`[config] config-override.json non leggibile: ${e.message}`);
  }
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
  queue: { total: 0, current: 0, remaining: 0 },
  keys: {
    heygen:    !!config.heygen.apiKey    && !config.heygen.apiKey.includes('...'),
    gemini:    !!config.gemini?.apiKey   && !config.gemini?.apiKey.includes('...'),
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
async function runPipeline(userId) {
  if (pipelineState.status === 'running') return;
  setState({ status: 'running', lastRun: new Date().toISOString(), steps: [], lastResult: null, userId });
  logger.info(`─── Avvio ciclo pipeline [user: ${userId}] ───`);

  // Applica la configurazione dell'utente a process.env
  const userCfg = readUserConfig(userId);
  for (const [k, v] of Object.entries(userCfg)) process.env[k] = String(v);

  const topicsFile = getUserTopicsFile(userId);
  let currentTopicId = null;

  try {
    // Step 1 — Topic
    setStep('Topic', 'running');
    const { selectTopic } = await import('./tools/select-topic.js');
    const item = await selectTopic(topicsFile);
    if (!item) {
      logger.warn('Nessun topic disponibile — pipeline saltata');
      setStep('Topic', 'skipped', 'Nessun topic disponibile');
      setState({ status: 'idle' });
      return;
    }
    setStep('Topic', 'done', item.topic);
    logger.info(`Topic: "${item.topic}" [${item.pilastro}]`);
    currentTopicId = item.id;

    // Step 2 — Script
    setStep('Script', 'running');
    const { generateScript } = await import('./tools/generate-script.js');
    const script = await generateScript(item.topic, item.pilastro, item.parlato);
    const scriptSource = (item.parlato?.trim().length > 20) ? 'da Excel' : 'da Gemini AI';
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
    if (currentTopicId) { const t = readUserTopics(userId); const it = t.find(x => x.id === currentTopicId); if (it) { it.status = 'done'; writeUserTopics(userId, t); } }

  } catch (err) {
    logger.error(`Pipeline fallita: ${err.message}`);
    logger.error(err.stack);
    const running = pipelineState.steps.find(s => s.status === 'running');
    if (running) setStep(running.name, 'error', err.message.slice(0, 60));
    setState({ status: 'error', lastResult: err.message });
    if (currentTopicId) { const t = readUserTopics(userId); const it = t.find(x => x.id === currentTopicId); if (it) { it.status = 'error'; writeUserTopics(userId, t); } }
  }
}

// ─── Telegram Bot ────────────────────────────────────────────────────────────
const telegram = startTelegramBot(
  () => { const admin = readUsers().find(u => u.role === 'admin'); runPipelineAll(admin?.id); },
  () => pipelineState,
);

/**
 * Esegue il pipeline in loop per tutti i topic pending.
 * Dopo ogni video completato, invia il link su Telegram.
 * Al termine di tutti, invia un riepilogo finale.
 */
async function runPipelineAll(userId) {
  const results = [];
  let processed = 0;

  const totalToProcess = readUserTopics(userId).filter(t => t.status === 'pending').length;
  if (totalToProcess === 0) {
    telegram.sendMessage('📭 Nessun topic pending da processare.');
    return;
  }
  logger.info(`Coda: ${totalToProcess} topic pending da elaborare`);
  setState({ ...pipelineState, queue: { total: totalToProcess, current: 0, remaining: totalToProcess } });

  while (true) {
    const pendingTopics = readUserTopics(userId).filter(t => t.status === 'pending');
    if (!pendingTopics.length) break;

    const currentNum = processed + 1;
    setState({ ...pipelineState, queue: { total: totalToProcess, current: currentNum, remaining: pendingTopics.length } });
    logger.info(`▶ Video ${currentNum} di ${totalToProcess} — topic: "${pendingTopics[0].topic}"`);

    await runPipeline(userId);
    processed++;

    if (pipelineState.status === 'success' && pipelineState.lastResult) {
      const lastTopic = pipelineState.steps.find(s => s.name === 'Topic');
      results.push({ topic: lastTopic?.detail || `Video #${processed}`, path: pipelineState.lastResult });
      telegram.sendMessage(
        `✅ <b>Video ${currentNum}/${totalToProcess} completato!</b>\n\n` +
        `📹 ${lastTopic?.detail || 'Video'}\n` +
        `📁 ${path.basename(pipelineState.lastResult)}`
      );
    } else if (pipelineState.status === 'error') {
      const lastTopic = pipelineState.steps.find(s => s.name === 'Topic');
      telegram.sendMessage(
        `❌ <b>Errore video ${currentNum}/${totalToProcess}</b>\n\n` +
        `📹 ${lastTopic?.detail || 'Video'}\n` +
        `⚠️ ${pipelineState.lastResult || 'Errore sconosciuto'}\n\n` +
        `➡️ Continuo con il prossimo topic…`
      );
    }
  }

  setState({ ...pipelineState, queue: { total: totalToProcess, current: totalToProcess, remaining: 0 } });

  if (results.length > 0) {
    const lines = results.map((r, i) =>
      `  ${i + 1}. <b>${r.topic}</b>\n     📁 ${path.basename(r.path)}`
    ).join('\n\n');
    telegram.sendMessage(
      `🎬 <b>Pipeline completata!</b>\n\n` +
      `📊 ${results.length}/${totalToProcess} video generati:\n\n${lines}`
    );
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST API
app.get('/api/status', requireAuth, (_req, res) => res.json(pipelineState));

app.get('/api/logs', requireAuth, (_req, res) => res.json({ lines: readLastLines() }));

app.post('/api/run', requireAuth, (req, res) => {
  if (pipelineState.status === 'running') {
    return res.status(409).json({ error: 'Pipeline già in esecuzione' });
  }
  res.json({ ok: true });
  runPipelineAll(req.effectiveUserId);
});

// ─── Auth Routes ────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatori' });
  const users = readUsers();
  const user  = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  if (user.active === false) return res.status(403).json({ error: 'Account disabilitato. Contatta l\'amministratore.' });
  if (user.approved === false) return res.status(403).json({ error: 'pending', message: 'Registrazione in attesa di approvazione. Riceverai una conferma a breve.' });
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  logger.info(`Login: ${email} [${user.role}]`);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatori' });
  if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri' });
  const users = readUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'Email già registrata' });
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: randomUUID(), email, name: name?.trim() || email,
    passwordHash: hash, role: 'user', plan: 'basic',
    active: true, approved: false, createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  fs.mkdirSync(getUserDir(user.id), { recursive: true });
  logger.info(`Nuova registrazione in attesa di approvazione: ${email}`);
  res.json({ ok: true, message: 'Registrazione inviata! Attendi l\'approvazione dell\'amministratore.' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const users = readUsers();
  const user  = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  const { passwordHash: _ph, ...safe } = user;
  res.json(safe);
});

app.patch('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Parametri mancanti' });
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.user.id);
  if (idx < 0) return res.status(404).json({ error: 'Utente non trovato' });
  const ok = await bcrypt.compare(currentPassword, users[idx].passwordHash);
  if (!ok) return res.status(400).json({ error: 'Password attuale non corretta' });
  users[idx].passwordHash = await bcrypt.hash(newPassword, 10);
  writeUsers(users);
  logger.info(`Password cambiata: ${users[idx].email}`);
  res.json({ ok: true });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = readUsers().map(({ passwordHash, ...u }) => u);
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, name, password, role = 'user', plan = 'basic',
          sections = ['pipeline','topics','wizard','config'] } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email e password obbligatori' });
  const users = readUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'Email già registrata' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: randomUUID(), email, name: name || email, passwordHash: hash,
                 role, plan, active: true, approved: true, sections,
                 createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  fs.mkdirSync(getUserDir(user.id), { recursive: true });
  logger.info(`Admin: creato utente ${email} [${role}]`);
  const { passwordHash: _ph2, ...safe } = user;
  res.json({ ok: true, user: safe });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Utente non trovato' });
  const { password, passwordHash: _h, ...rest } = req.body;
  if (password) rest.passwordHash = await bcrypt.hash(password, 10);
  users[idx] = { ...users[idx], ...rest };
  writeUsers(users);
  const { passwordHash: _ph3, ...safe } = users[idx];
  res.json({ ok: true, user: safe });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  const users = readUsers().filter(u => u.id !== req.params.id);
  writeUsers(users);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/toggle-active', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Non puoi disabilitare te stesso' });
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Utente non trovato' });
  if (users[idx].role === 'admin') return res.status(400).json({ error: 'Non puoi disabilitare un admin' });
  users[idx].active = users[idx].active === false ? true : false;
  writeUsers(users);
  logger.info(`Admin: ${users[idx].active ? 'abilitato' : 'disabilitato'} utente ${users[idx].email}`);
  res.json({ ok: true, active: users[idx].active });
});

app.get('/api/admin/users/:id/config', requireAuth, requireAdmin, (req, res) => {
  res.json(readUserConfig(req.params.id));
});

app.patch('/api/admin/users/:id/config', requireAuth, requireAdmin, (req, res) => {
  writeUserConfig(req.params.id, req.body);
  res.json({ ok: true });
});

app.get('/api/admin/users/:id/topics', requireAuth, requireAdmin, (req, res) => {
  res.json(readUserTopics(req.params.id));
});

app.post('/api/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Utente non trovato' });
  users[idx].approved = true;
  users[idx].active   = true;
  writeUsers(users);
  logger.info(`Admin: approvato utente ${users[idx].email}`);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers().filter(u => u.id !== req.params.id);
  writeUsers(users);
  logger.info(`Admin: rifiutato e rimosso utente ${req.params.id}`);
  res.json({ ok: true });
});

// ─── Topics API ─────────────────────────────────────────────────────────────

// GET  /api/topics — legge topics dell'utente
app.get('/api/topics', requireAuth, (req, res) => res.json(readUserTopics(req.effectiveUserId)));

// POST /api/topics/upload — carica XLSX
app.post('/api/topics/upload', requireAuth, upload.single('file'), (req, res) => {
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

    writeUserTopics(req.effectiveUserId, topics);
    logger.info(`Topics importati: ${topics.length} righe da XLSX`);
    res.json({ ok: true, count: topics.length, topics });
  } catch (err) {
    logger.error(`Upload XLSX fallito: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/topics/:id — aggiorna status di un topic
app.patch('/api/topics/:id', requireAuth, (req, res) => {
  const id     = parseInt(req.params.id);
  const topics = readUserTopics(req.effectiveUserId);
  const idx    = topics.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Topic non trovato' });
  topics[idx]  = { ...topics[idx], ...req.body };
  writeUserTopics(req.effectiveUserId, topics);
  res.json(topics[idx]);
});

// DELETE /api/topics/:id — elimina un topic
app.delete('/api/topics/:id', requireAuth, (req, res) => {
  const id     = parseInt(req.params.id);
  const topics = readUserTopics(req.effectiveUserId).filter(t => t.id !== id);
  writeUserTopics(req.effectiveUserId, topics);
  res.json({ ok: true });
});

// ─── Config API ─────────────────────────────────────────────────────────────

const ENV_FILE            = path.join(__dirname, '.env');
const ENV_KNOWN_KEYS = [
  'HEYGEN_API_KEY','HEYGEN_AVATAR_ID','HEYGEN_VOICE_ID','HEYGEN_MOTION_ENGINE',
  'HEYGEN_ASPECT_RATIO','HEYGEN_RESOLUTION','HEYGEN_EXPRESSIVENESS','HEYGEN_EXPRESSION_INTENSITY',
  'HEYGEN_AVATAR_STYLE','HEYGEN_BG_COLOR','HEYGEN_REMOVE_BG','HEYGEN_MOTION_PROMPT',
  'HEYGEN_VOICE_SPEED','HEYGEN_VOICE_PITCH','HEYGEN_VOICE_EMOTION','HEYGEN_VOICE_LOCALE',
  'HEYGEN_BG_TYPE','HEYGEN_BG_IMAGE_URL','HEYGEN_BG_PLAY_STYLE',
  'HEYGEN_CIRCLE_BG_COLOR','HEYGEN_AVATAR_OFFSET_X','HEYGEN_AVATAR_OFFSET_Y',
  'HEYGEN_CAPTION','HEYGEN_VIDEO_TITLE','HEYGEN_TEST_MODE',
  'GEMINI_API_KEY','GEMINI_MODEL',
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
  // ⚡ PRINCIPIO: la configurazione è la legge.
  // 1. Applica IMMEDIATAMENTE a process.env (effetto per tutti i tool nella stessa sessione)
  for (const [k, v] of Object.entries(vars)) process.env[k] = String(v);

  // 2. SEMPRE scrivi sul .env locale (fonte di verità persistente su disco)
  try {
    const existingEnv = {};
    if (fs.existsSync(ENV_FILE)) {
      const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) existingEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    const merged  = { ...existingEnv, ...vars };
    const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(ENV_FILE, content);
  } catch (e) {
    logger.warn(`writeEnvFile: impossibile scrivere .env: ${e.message}`);
  }

  // 3. Su Railway: ANCHE config-override.json su volume /data (persiste tra i deploy)
  if (process.env.RAILWAY_ENVIRONMENT_NAME) {
    try {
      const existing = fs.existsSync(CONFIG_OVERRIDE_FILE)
        ? JSON.parse(fs.readFileSync(CONFIG_OVERRIDE_FILE, 'utf8'))
        : {};
      const merged = { ...existing, ...vars };
      fs.writeFileSync(CONFIG_OVERRIDE_FILE, JSON.stringify(merged, null, 2));
    } catch (e) {
      logger.warn(`writeEnvFile: impossibile scrivere config-override.json: ${e.message}`);
    }
  }
}

function maskKey(val) {
  if (!val || val.includes('...') || val.length < 6) return '';
  return val.slice(0, 4) + '••••••••' + val.slice(-4);
}

// GET /api/config — restituisce config corrente (chiavi mascherate)
app.get('/api/config', requireAuth, (req, res) => {
  const env = readUserConfig(req.effectiveUserId);
  res.json({
    HEYGEN_API_KEY:                maskKey(env.HEYGEN_API_KEY),
    HEYGEN_AVATAR_ID:              env.HEYGEN_AVATAR_ID              || '',
    HEYGEN_VOICE_ID:               env.HEYGEN_VOICE_ID               || '',
    HEYGEN_MOTION_ENGINE:          env.HEYGEN_MOTION_ENGINE          || '3',
    HEYGEN_ASPECT_RATIO:           env.HEYGEN_ASPECT_RATIO           || '9:16',
    HEYGEN_RESOLUTION:             env.HEYGEN_RESOLUTION             || '1080p',
    HEYGEN_EXPRESSIVENESS:         env.HEYGEN_EXPRESSIVENESS         || 'medium',
    HEYGEN_EXPRESSION_INTENSITY:   env.HEYGEN_EXPRESSION_INTENSITY   || '0.30',
    HEYGEN_REMOVE_BG:              env.HEYGEN_REMOVE_BG              || 'false',
    HEYGEN_MOTION_PROMPT:          env.HEYGEN_MOTION_PROMPT          || '',
    HEYGEN_AVATAR_STYLE:           env.HEYGEN_AVATAR_STYLE           || 'normal',
    HEYGEN_BG_COLOR:               env.HEYGEN_BG_COLOR               || '#1a1a1a',
    HEYGEN_VOICE_SPEED:            env.HEYGEN_VOICE_SPEED            || '1.0',
    HEYGEN_VOICE_PITCH:            env.HEYGEN_VOICE_PITCH            || '0',
    HEYGEN_VOICE_EMOTION:          env.HEYGEN_VOICE_EMOTION          || '',
    HEYGEN_VOICE_LOCALE:           env.HEYGEN_VOICE_LOCALE           || '',
    HEYGEN_BG_TYPE:                env.HEYGEN_BG_TYPE                || 'color',
    HEYGEN_BG_IMAGE_URL:           env.HEYGEN_BG_IMAGE_URL           || '',
    HEYGEN_BG_PLAY_STYLE:          env.HEYGEN_BG_PLAY_STYLE          || 'loop',
    HEYGEN_CIRCLE_BG_COLOR:        env.HEYGEN_CIRCLE_BG_COLOR        || '#000000',
    HEYGEN_AVATAR_OFFSET_X:        env.HEYGEN_AVATAR_OFFSET_X        || '0.00',
    HEYGEN_AVATAR_OFFSET_Y:        env.HEYGEN_AVATAR_OFFSET_Y        || '0.00',
    HEYGEN_CAPTION:                env.HEYGEN_CAPTION                || 'false',
    HEYGEN_VIDEO_TITLE:            env.HEYGEN_VIDEO_TITLE            || '',
    HEYGEN_TEST_MODE:              env.HEYGEN_TEST_MODE              || 'false',
    GEMINI_API_KEY:                maskKey(env.GEMINI_API_KEY),
    GEMINI_MODEL:                  env.GEMINI_MODEL                  || 'gemini-2.0-flash',
    META_ACCESS_TOKEN:             maskKey(env.META_ACCESS_TOKEN),
    INSTAGRAM_ACCOUNT_ID:          env.INSTAGRAM_ACCOUNT_ID          || '',
    TELEGRAM_BOT_TOKEN:            maskKey(env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID:              env.TELEGRAM_CHAT_ID              || '',
    CRON_SCHEDULE:                 env.CRON_SCHEDULE                 || '30 9 * * 1,3,5',
    PHOTOS_BASE_PATH:              env.PHOTOS_BASE_PATH              || './assets/photos',
    // flags di presenza (senza mascheratura)
    _has: {
      heygenKey:      !!(env.HEYGEN_API_KEY     && !env.HEYGEN_API_KEY.includes('...')),
      geminiKey:      !!(env.GEMINI_API_KEY     && !env.GEMINI_API_KEY.includes('...')),
      metaToken:      !!(env.META_ACCESS_TOKEN  && !env.META_ACCESS_TOKEN.includes('...')),
      telegramToken:  !!(env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('...')),
    },
  });
});

// POST /api/config — salva variabili nel profilo utente
app.post('/api/config', requireAuth, (req, res) => {
  try {
    const allowed = [
      'HEYGEN_API_KEY','HEYGEN_AVATAR_ID','HEYGEN_VOICE_ID','HEYGEN_MOTION_ENGINE',
      'HEYGEN_ASPECT_RATIO','HEYGEN_RESOLUTION','HEYGEN_EXPRESSIVENESS','HEYGEN_EXPRESSION_INTENSITY',
      'HEYGEN_AVATAR_STYLE','HEYGEN_BG_COLOR','HEYGEN_REMOVE_BG','HEYGEN_MOTION_PROMPT',
      'HEYGEN_VOICE_SPEED','HEYGEN_VOICE_PITCH','HEYGEN_VOICE_EMOTION','HEYGEN_VOICE_LOCALE',
      'HEYGEN_BG_TYPE','HEYGEN_BG_IMAGE_URL','HEYGEN_BG_PLAY_STYLE',
      'HEYGEN_CIRCLE_BG_COLOR','HEYGEN_AVATAR_OFFSET_X','HEYGEN_AVATAR_OFFSET_Y',
      'HEYGEN_CAPTION','HEYGEN_VIDEO_TITLE','HEYGEN_TEST_MODE',
      'GEMINI_API_KEY','GEMINI_MODEL',
      'META_ACCESS_TOKEN','INSTAGRAM_ACCOUNT_ID',
      'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID',
      'CRON_SCHEDULE','PHOTOS_BASE_PATH',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== '' && !String(req.body[key]).includes('••••')) {
        const val = String(req.body[key]).trim();
        if ((key === 'HEYGEN_BG_IMAGE_URL') && val.startsWith('data:')) {
          logger.warn(`Config: ${key} rifiutato perché è un data URI base64 (usa un URL HTTPS)`);
          continue;
        }
        patch[key] = val;
      }
    }
    if (!Object.keys(patch).length) return res.json({ ok: true, saved: 0 });
    writeUserConfig(req.effectiveUserId, patch);
    logger.info(`Config aggiornata [user: ${req.effectiveUserId}]: ${Object.keys(patch).join(', ')}`);
    res.json({ ok: true, saved: Object.keys(patch).length, keys: Object.keys(patch) });
  } catch(err) {
    logger.error(`Salvataggio config fallito: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/heygen/avatars — lista avatar disponibili
app.get('/api/heygen/avatars', requireAuth, async (req, res) => {
  try {
    const env    = readUserConfig(req.effectiveUserId);
    const apiKey = env.HEYGEN_API_KEY || process.env.HEYGEN_API_KEY;
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
app.get('/api/heygen/voices', requireAuth, async (req, res) => {
  try {
    const env    = readUserConfig(req.effectiveUserId);
    const apiKey = env.HEYGEN_API_KEY || process.env.HEYGEN_API_KEY;
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

// GET /api/heygen/debug-payload — mostra ESATTAMENTE il JSON che verrebbe inviato a HeyGen
// senza fare nessuna chiamata API. Utile per verificare che la config sia corretta.
app.get('/api/heygen/debug-payload', requireAuth, async (_req, res) => {
  try {
    const { buildHeygenPayload } = await import('./tools/create-heygen-video.js');
    const { cfg, payload } = buildHeygenPayload('[testo di prova — 50 caratteri circa per test]');
    // Maschera API key nel debug output
    const safeCfg = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0,8) + '••••' : 'MANCANTE' };
    res.json({
      ok: true,
      endpoint: 'POST https://api.heygen.com/v2/videos',
      process_env: {
        HEYGEN_AVATAR_ID:      process.env.HEYGEN_AVATAR_ID,
        HEYGEN_VOICE_ID:       process.env.HEYGEN_VOICE_ID,
        HEYGEN_MOTION_ENGINE:  process.env.HEYGEN_MOTION_ENGINE,
        HEYGEN_ASPECT_RATIO:   process.env.HEYGEN_ASPECT_RATIO,
        HEYGEN_RESOLUTION:     process.env.HEYGEN_RESOLUTION,
        HEYGEN_EXPRESSIVENESS: process.env.HEYGEN_EXPRESSIVENESS,
        HEYGEN_VOICE_EMOTION:  process.env.HEYGEN_VOICE_EMOTION,
        HEYGEN_VOICE_LOCALE:   process.env.HEYGEN_VOICE_LOCALE,
        HEYGEN_TEST_MODE:      process.env.HEYGEN_TEST_MODE,
        HEYGEN_BG_TYPE:        process.env.HEYGEN_BG_TYPE,
        HEYGEN_BG_COLOR:       process.env.HEYGEN_BG_COLOR,
        HEYGEN_CAPTION:        process.env.HEYGEN_CAPTION,
      },
      config_parsed: safeCfg,
      payload_json: payload,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Wizard API ─────────────────────────────────────────────────────────────

const WIZARD_SYSTEM_PROMPT = `Sei un esperto stratega di contenuti video per social media.
Il tuo compito è generare una lista di topic per video brevi (Reel, Short, TikTok), basandoti sulle risposte di un questionario.
L'argomento può essere qualsiasi cosa: politica, sport, scienza, tecnologia, AI, medicina, religione, cucina, finanza, moda, filosofia, viaggi, musica, cinema, fitness, business, psicologia, o qualsiasi altro settore.

Genera ESATTAMENTE il numero di topic richiesto (campo "qty").
Per ogni topic produci un oggetto JSON con questi campi:
- "topic": titolo del video (max 65 caratteri, incisivo, curioso, adatto ai social)
- "pilastro": categoria del contenuto coerente con l'argomento (es. "educativo", "opinione", "tutorial", "notizia", "ispirazione", "dietro le quinte", "intervista" — scegli il più adatto o usa quello indicato nel questionario)
- "photoId": suggerisci un nome file immagine descrittivo coerente con il topic (es. "ai_futuro_01.jpg") o ""
- "parlato": se nel questionario ci sono testi base, adattali per questo topic (max 300 caratteri). Altrimenti lascia "" (verrà generato in seguito)
- "note": breve nota sul focus o l'angolazione di questo specifico video

REGOLE:
- I topic devono essere DIVERSI tra loro, coprire angolazioni diverse dello stesso argomento
- Rispetta fedelmente stile, target, formato e CTA indicati nel questionario
- Se il pilastro è "misto" o "vario", distribuisci in modo equilibrato tra tipi diversi
- Adatta il linguaggio al target indicato
- Rispondi SOLO con un array JSON valido, nessun testo aggiuntivo, nessun markdown`;

// POST /api/wizard/generate — Gemini genera i topic dal questionario
app.post('/api/wizard/generate', requireAuth, async (req, res) => {
  try {
    const env    = readUserConfig(req.effectiveUserId);
    const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'GEMINI_API_KEY non configurata' });

    const answers = req.body;
    const qty     = parseInt(answers.qty) || 5;

    const userMessage = `Questionario compilato:
- Numero di video: ${qty}
- Argomento principale: ${answers.subject || 'non specificato'}
- Categoria/Pilastro: ${answers.pilastro || 'misto'}
- Pubblico target: ${answers.target || 'non specificato'}
- Formato video: ${answers.formato || 'non specificato'}
- Stile comunicativo: ${answers.stile || 'educativo'}
- Elemento specifico da evidenziare: ${answers.elemento || 'nessuno'}
- Messaggio chiave: ${answers.messaggio || 'non specificato'}
- Testi base già scritti: ${answers.parlato || 'nessuno — genera tutto tu'}
- Call-to-action: ${answers.cta || 'nessuna'}
- Note aggiuntive: ${answers.note || 'nessuna'}

Genera esattamente ${qty} topic diversi tra loro sull'argomento indicato.`;

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({
      model:             env.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      systemInstruction: WIZARD_SYSTEM_PROMPT,
    });
    const result = await model.generateContent(userMessage);
    const text   = result.response.text().trim();

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Gemini non ha restituito un JSON valido');

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

    logger.info(`Wizard: generati ${topics.length} topic con Gemini`);
    res.json({ ok: true, count: topics.length, topics });
  } catch (err) {
    logger.error(`Wizard generate: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wizard/export-xlsx — scarica i topic generati come file Excel
app.post('/api/wizard/export-xlsx', requireAuth, (req, res) => {
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
    res.setHeader('Content-Disposition', `attachment; filename="topics-wizard.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wizard/import — importa direttamente i topic generati nella pipeline
app.post('/api/wizard/import', requireAuth, (req, res) => {
  try {
    const { topics } = req.body;
    if (!topics?.length) return res.status(400).json({ error: 'Nessun topic fornito' });
    const existing = readUserTopics(req.effectiveUserId);
    const maxId    = existing.length ? Math.max(...existing.map(t => t.id)) : 0;
    const toAdd    = topics.map((t, i) => ({ ...t, id: maxId + i + 1, status: 'pending' }));
    writeUserTopics(req.effectiveUserId, [...existing, ...toAdd]);
    logger.info(`Wizard import: ${toAdd.length} topic aggiunti [user: ${req.effectiveUserId}]`);
    res.json({ ok: true, count: toAdd.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/topics/template — scarica template XLSX precompilato
app.get('/api/topics/template', requireAuth, (_req, res) => {
  const data = [
    {
      topic:    'come l\'intelligenza artificiale cambia il lavoro nel 2025',
      pilastro: 'educativo',
      photoId:  'ai_lavoro_01.jpg',
      parlato:  'Nel 2025 il 40% dei lavori amministrativi è già parzialmente automatizzato. Ma l\'AI non sostituisce le persone: potenzia chi sa usarla. Inizia oggi, anche con 10 minuti al giorno.',
      note:     'Tono ottimista, dati recenti',
      status:   'pending',
    },
    {
      topic:    '3 strumenti AI gratuiti che non conosci ancora',
      pilastro: 'tutorial',
      photoId:  'ai_tools_02.jpg',
      parlato:  '',
      note:     'Lascia vuoto: Claude genera il testo automaticamente',
      status:   'pending',
    },
    {
      topic:    'il futuro che nessuno ti sta raccontando',
      pilastro: 'opinione',
      photoId:  'futuro_03.jpg',
      parlato:  '',
      note:     'Angolazione provocatoria',
      status:   'pending',
    },
    {
      topic:    'la mia storia con la tecnologia',
      pilastro: 'ispirazione',
      photoId:  'story_04.jpg',
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
  res.setHeader('Content-Disposition', 'attachment; filename="topics-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// SSE — real-time events stream (token via query: /api/events?token=...)
app.get('/api/events', requireAuth, (req, res) => {
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

// Bootstrap admin + avvio
(async () => {
  await bootstrapAdmin();

  // Cron scheduler — usa admin user
  cron.schedule(config.cron.schedule, () => {
    const admin = readUsers().find(u => u.role === 'admin');
    logger.info(`Cron triggered: ${new Date().toISOString()}`);
    telegram.sendMessage('⏰ <b>Cron attivato</b> — avvio pipeline automatico...');
    runPipelineAll(admin?.id);
  }, { timezone: 'Europe/Rome' });

  // Avvia log watcher
  startLogWatcher();

  // Avvia HTTP server
  const PORT = process.env.PORT || 3333;
  createServer(app).listen(PORT, () => {
    logger.info(`Dashboard: http://localhost:${PORT}`);
    import('child_process').then(({ exec }) => {
      exec(`start http://localhost:${PORT}`);
    });
  });

  logger.info(`Scheduler attivo: ${config.cron.schedule} (Europe/Rome)`);
  logger.info('Premi Ctrl+C per fermare.');
})();
