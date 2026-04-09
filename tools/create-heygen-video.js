/**
 * CREATE HEYGEN VIDEO
 * Genera un video con HeyGen partendo dal testo parlato.
 * Fa polling fino a completamento (max 10 minuti).
 * Restituisce l'URL pubblico del video .mp4.
 *
 * ⚡ PRINCIPIO: la configurazione è la legge.
 *    Tutti i parametri vengono letti da process.env al momento della chiamata
 *    (non da valori cachati all'avvio). La dashboard aggiorna process.env
 *    direttamente → ogni run usa sempre le impostazioni più recenti.
 */

import axios  from 'axios';
import { logger } from '../config/logger.js';

const BASE             = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 10_000;  // 10 secondi
const POLL_MAX         = 60;      // 10 minuti max

/**
 * Legge la configurazione HeyGen FRESCA da process.env.
 * Chiamata ad ogni esecuzione — mai valori cachati.
 */
function readHeygenConfig() {
  return {
    apiKey:            process.env.HEYGEN_API_KEY,
    avatarId:          process.env.HEYGEN_AVATAR_ID,
    voiceId:           process.env.HEYGEN_VOICE_ID,
    motionEngine:      process.env.HEYGEN_MOTION_ENGINE        || '3',
    aspectRatio:       process.env.HEYGEN_ASPECT_RATIO         || '9:16',
    exprIntensity:     parseFloat(process.env.HEYGEN_EXPRESSION_INTENSITY ?? 0.3),
    avatarStyle:       process.env.HEYGEN_AVATAR_STYLE         || 'normal',
    bgColor:           process.env.HEYGEN_BG_COLOR             || '#1a1a1a',
    voiceSpeed:        parseFloat(process.env.HEYGEN_VOICE_SPEED    ?? 1.0),
    voicePitch:        parseInt(process.env.HEYGEN_VOICE_PITCH       ?? 0, 10),
    voiceEmotion:      process.env.HEYGEN_VOICE_EMOTION        || '',
    voiceLocale:       process.env.HEYGEN_VOICE_LOCALE         || '',
    bgType:            process.env.HEYGEN_BG_TYPE              || 'color',
    bgImageUrl:        process.env.HEYGEN_BG_IMAGE_URL         || '',
    bgPlayStyle:       process.env.HEYGEN_BG_PLAY_STYLE        || 'loop',
    circleBgColor:     process.env.HEYGEN_CIRCLE_BG_COLOR      || '#000000',
    offsetX:           parseFloat(process.env.HEYGEN_AVATAR_OFFSET_X ?? 0),
    offsetY:           parseFloat(process.env.HEYGEN_AVATAR_OFFSET_Y ?? 0),
    caption:           process.env.HEYGEN_CAPTION === 'true',
    videoTitle:        process.env.HEYGEN_VIDEO_TITLE          || '',
    // HEYGEN_TEST_MODE=false per usare avatar/aspect ratio reali senza watermark.
    // Se non impostato, default = false (mai test mode silenzioso).
    testMode:          process.env.HEYGEN_TEST_MODE === 'true',
  };
}

export async function createHeygenVideo(scriptText) {
  // ── Legge config FRESCA (non cachata) ────────────────────────────────────
  const cfg = readHeygenConfig();

  // ── Validazione obbligatoria ─────────────────────────────────────────────
  if (!cfg.apiKey)   throw new Error('HEYGEN_API_KEY mancante nella configurazione');
  if (!cfg.avatarId) throw new Error('HEYGEN_AVATAR_ID mancante nella configurazione');
  if (!cfg.voiceId)  throw new Error('HEYGEN_VOICE_ID mancante nella configurazione');

  // ── Log completo PRIMA della chiamata API (debug configurazione) ─────────
  logger.info('━━━ HeyGen Config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`  avatar_id    : ${cfg.avatarId}`);
  logger.info(`  voice_id     : ${cfg.voiceId}`);
  logger.info(`  aspect_ratio : ${cfg.aspectRatio}`);
  logger.info(`  motion_engine: Avatar ${cfg.motionEngine}`);
  logger.info(`  avatar_style : ${cfg.avatarStyle}`);
  logger.info(`  bg_type      : ${cfg.bgType} / ${cfg.bgColor}`);
  logger.info(`  voice_speed  : ${cfg.voiceSpeed} | pitch: ${cfg.voicePitch} | emotion: ${cfg.voiceEmotion || '—'}`);
  logger.info(`  caption      : ${cfg.caption} | test_mode: ${cfg.testMode}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const headers = {
    'X-Api-Key':    cfg.apiKey,
    'Content-Type': 'application/json',
  };

  // ── motion_mode: Avatar III = 'standard', Avatar IV = 'normal' ──────────
  const motionMode = cfg.motionEngine === '4' ? 'normal' : 'standard';

  // ── Background ───────────────────────────────────────────────────────────
  // HeyGen accetta solo URL HTTPS — rifiuta data URI (base64) silenziosamente
  const safeImageUrl = cfg.bgImageUrl && !cfg.bgImageUrl.startsWith('data:') ? cfg.bgImageUrl : '';
  if (cfg.bgImageUrl && cfg.bgImageUrl.startsWith('data:')) {
    logger.warn('HeyGen: HEYGEN_BG_IMAGE_URL è un data URI base64 — verrà usato il colore di sfondo');
  }

  let background;
  if (cfg.bgType === 'image' && safeImageUrl) {
    background = { type: 'image', url: safeImageUrl };
  } else if (cfg.bgType === 'video' && safeImageUrl) {
    background = { type: 'video', url: safeImageUrl, play_style: cfg.bgPlayStyle };
  } else {
    background = { type: 'color', value: cfg.bgColor };
  }

  // ── Voice ────────────────────────────────────────────────────────────────
  const voiceObj = {
    type:       'text',
    input_text: scriptText,
    voice_id:   cfg.voiceId,
    speed:      cfg.voiceSpeed,
    pitch:      cfg.voicePitch,
  };
  if (cfg.voiceEmotion) voiceObj.emotion = cfg.voiceEmotion;
  if (cfg.voiceLocale)  voiceObj.locale  = cfg.voiceLocale;

  // ── Character (Avatar) ───────────────────────────────────────────────────
  const characterObj = {
    type:                 'avatar',
    avatar_id:            cfg.avatarId,
    avatar_style:         cfg.avatarStyle,
    motion_mode:          motionMode,
    expression_intensity: cfg.exprIntensity,
  };
  if (cfg.avatarStyle === 'circle' && cfg.circleBgColor) {
    characterObj.circle_background_color = cfg.circleBgColor;
  }
  if (cfg.offsetX !== 0 || cfg.offsetY !== 0) {
    characterObj.offset = { x: cfg.offsetX, y: cfg.offsetY };
  }

  // ── Payload finale ───────────────────────────────────────────────────────
  const payload = {
    video_inputs: [{ character: characterObj, voice: voiceObj, background }],
    aspect_ratio: cfg.aspectRatio,
    caption:      cfg.caption,
    test:         cfg.testMode,   // ← controllato esplicitamente da HEYGEN_TEST_MODE
  };
  if (cfg.videoTitle) payload.title = cfg.videoTitle;

  logger.info(`HeyGen: avvio generazione — aspect=${cfg.aspectRatio}, avatar=${cfg.avatarId}, test=${cfg.testMode}`);

  // ── 1. Invia richiesta ───────────────────────────────────────────────────
  let genRes;
  try {
    genRes = await axios.post(`${BASE}/v2/video/generate`, payload, { headers });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`HeyGen /v2/video/generate → ${err.response?.status ?? '?'}: ${detail}`);
  }
  const videoId = genRes.data?.data?.video_id;
  if (!videoId) throw new Error(`HeyGen non ha restituito video_id: ${JSON.stringify(genRes.data)}`);

  logger.info(`HeyGen: video_id=${videoId} — polling ogni ${POLL_INTERVAL_MS / 1000}s`);

  // ── 2. Polling fino a completamento ──────────────────────────────────────
  for (let i = 1; i <= POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await axios.get(
      `${BASE}/v1/video_status.get?video_id=${videoId}`,
      { headers }
    );
    const data   = statusRes.data?.data || {};
    const status = data.status;
    const url    = data.video_url;

    logger.info(`HeyGen polling [${i * 10}s]: ${status}`);

    if (status === 'completed' && url) {
      logger.info(`HeyGen: video completato → ${url}`);
      return url;
    }

    if (status === 'failed') {
      throw new Error(`HeyGen video fallito: ${JSON.stringify(data.error || data)}`);
    }
  }

  throw new Error(`HeyGen: timeout dopo ${(POLL_MAX * POLL_INTERVAL_MS) / 60000} minuti`);
}
