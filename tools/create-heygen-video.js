/**
 * CREATE HEYGEN VIDEO
 * Usa la nuova API HeyGen  POST /v2/videos  (Avatar IV / Photo Avatar)
 * Polling su  GET /v2/videos/{video_id}
 * Restituisce l'URL pubblico del video .mp4.
 *
 * ⚡ PRINCIPIO: la configurazione è la legge.
 *    Tutti i parametri vengono letti da process.env al momento della chiamata
 *    (non da valori cachati all'avvio). La dashboard aggiorna process.env
 *    direttamente → ogni run usa sempre le impostazioni più recenti.
 *
 * Ref: https://docs.heygen.com/reference/generate-video-v2
 */

import axios from 'axios';
import { logger } from '../config/logger.js';

const BASE             = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 10_000;  // 10 secondi
const POLL_MAX         = 60;      // 10 minuti max

/**
 * Mappa float 0-1 → 'low' | 'medium' | 'high'
 * (usato come fallback se HEYGEN_EXPRESSIVENESS non è impostato)
 */
function intensityToExpressiveness(val) {
  if (val <= 0.33) return 'low';
  if (val <= 0.66) return 'medium';
  return 'high';
}

/**
 * Legge la configurazione HeyGen FRESCA da process.env.
 * Chiamata ad ogni esecuzione — mai valori cachati.
 */
function readHeygenConfig() {
  const rawIntensity = parseFloat(process.env.HEYGEN_EXPRESSION_INTENSITY ?? 0.3);
  return {
    apiKey:           process.env.HEYGEN_API_KEY,
    avatarId:         process.env.HEYGEN_AVATAR_ID,
    voiceId:          process.env.HEYGEN_VOICE_ID,
    // Avatar IV → use_avatar_iv_model=true  (HEYGEN_MOTION_ENGINE=4)
    useAvatarIV:      process.env.HEYGEN_MOTION_ENGINE === '4',
    aspectRatio:      process.env.HEYGEN_ASPECT_RATIO      || '9:16',
    resolution:       process.env.HEYGEN_RESOLUTION        || '1080p',
    // expressiveness: 'low' | 'medium' | 'high' (photo avatars)
    expressiveness:   process.env.HEYGEN_EXPRESSIVENESS    || intensityToExpressiveness(rawIntensity),
    removeBackground: process.env.HEYGEN_REMOVE_BG         === 'true',
    motionPrompt:     process.env.HEYGEN_MOTION_PROMPT      || '',
    bgType:           process.env.HEYGEN_BG_TYPE            || 'color',
    bgColor:          process.env.HEYGEN_BG_COLOR           || '#1a1a1a',
    bgImageUrl:       process.env.HEYGEN_BG_IMAGE_URL       || '',
    bgPlayStyle:      process.env.HEYGEN_BG_PLAY_STYLE      || 'loop',
    voiceSpeed:       parseFloat(process.env.HEYGEN_VOICE_SPEED  ?? 1.0),
    voicePitch:       parseInt(process.env.HEYGEN_VOICE_PITCH     ?? 0, 10),
    voiceEmotion:     process.env.HEYGEN_VOICE_EMOTION      || '',
    voiceLocale:      process.env.HEYGEN_VOICE_LOCALE       || '',
    caption:          process.env.HEYGEN_CAPTION            === 'true',
    videoTitle:       process.env.HEYGEN_VIDEO_TITLE        || '',
    // HEYGEN_TEST_MODE=false → video reale con avatar/voice/ratio configurati
    // HEYGEN_TEST_MODE=true  → watermark, avatar default, aspect ratio ignorato
    testMode:         process.env.HEYGEN_TEST_MODE          === 'true',
  };
}

export async function createHeygenVideo(scriptText) {
  // ── Legge config FRESCA (non cachata) ────────────────────────────────────
  const cfg = readHeygenConfig();

  // ── Validazione obbligatoria ─────────────────────────────────────────────
  if (!cfg.apiKey)   throw new Error('HEYGEN_API_KEY mancante nella configurazione');
  if (!cfg.avatarId) throw new Error('HEYGEN_AVATAR_ID mancante nella configurazione');
  if (!cfg.voiceId)  throw new Error('HEYGEN_VOICE_ID mancante nella configurazione');

  // ── Log completo PRIMA della chiamata API ────────────────────────────────
  logger.info('━━━ HeyGen Config (POST /v2/videos) ━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`  avatar_id       : ${cfg.avatarId}`);
  logger.info(`  voice_id        : ${cfg.voiceId}`);
  logger.info(`  aspect_ratio    : ${cfg.aspectRatio}`);
  logger.info(`  resolution      : ${cfg.resolution}`);
  logger.info(`  use_avatar_iv   : ${cfg.useAvatarIV}`);
  logger.info(`  expressiveness  : ${cfg.expressiveness}`);
  logger.info(`  remove_bg       : ${cfg.removeBackground}`);
  logger.info(`  motion_prompt   : ${cfg.motionPrompt || '—'}`);
  logger.info(`  bg_type         : ${cfg.bgType} / ${cfg.bgColor}`);
  logger.info(`  voice_speed     : ${cfg.voiceSpeed} | pitch: ${cfg.voicePitch} | emotion: ${cfg.voiceEmotion || '—'}`);
  logger.info(`  caption         : ${cfg.caption} | test_mode: ${cfg.testMode}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const headers = {
    'X-Api-Key':    cfg.apiKey,
    'Content-Type': 'application/json',
  };

  // ── Background ───────────────────────────────────────────────────────────
  const safeImageUrl = cfg.bgImageUrl && !cfg.bgImageUrl.startsWith('data:') ? cfg.bgImageUrl : '';
  if (cfg.bgImageUrl && cfg.bgImageUrl.startsWith('data:')) {
    logger.warn('HeyGen: HEYGEN_BG_IMAGE_URL è un data URI — verrà usato il colore di sfondo');
  }
  let background;
  if (cfg.bgType === 'image' && safeImageUrl) {
    background = { type: 'image', url: safeImageUrl };
  } else if (cfg.bgType === 'video' && safeImageUrl) {
    background = { type: 'video', url: safeImageUrl, play_style: cfg.bgPlayStyle };
  } else {
    background = { type: 'color', value: cfg.bgColor };
  }

  // ── Voice settings (nuovo formato /v2/videos) ────────────────────────────
  const voiceSettings = {};
  if (cfg.voiceSpeed !== 1.0)  voiceSettings.speed  = cfg.voiceSpeed;
  if (cfg.voicePitch !== 0)    voiceSettings.pitch  = cfg.voicePitch;
  if (cfg.voiceLocale)         voiceSettings.locale = cfg.voiceLocale;
  if (cfg.voiceEmotion)        voiceSettings.emotion = cfg.voiceEmotion;

  // ── Payload (nuovo formato flat /v2/videos) ──────────────────────────────
  const payload = {
    avatar_id:         cfg.avatarId,
    script:            scriptText,
    voice_id:          cfg.voiceId,
    aspect_ratio:      cfg.aspectRatio,
    resolution:        cfg.resolution,
    expressiveness:    cfg.expressiveness,
    remove_background: cfg.removeBackground,
    background,
    caption:           cfg.caption,
    test:              cfg.testMode,
  };

  if (cfg.useAvatarIV)                      payload.use_avatar_iv_model = true;
  if (cfg.motionPrompt)                     payload.motion_prompt       = cfg.motionPrompt;
  if (cfg.videoTitle)                       payload.title               = cfg.videoTitle;
  if (Object.keys(voiceSettings).length)    payload.voice_settings      = voiceSettings;

  logger.info(`HeyGen: avvio generazione — aspect=${cfg.aspectRatio}, avatar=${cfg.avatarId}, test=${cfg.testMode}`);

  // ── 1. POST /v2/videos ───────────────────────────────────────────────────
  let genRes;
  try {
    genRes = await axios.post(`${BASE}/v2/videos`, payload, { headers });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`HeyGen POST /v2/videos → ${err.response?.status ?? '?'}: ${detail}`);
  }
  const videoId = genRes.data?.data?.video_id || genRes.data?.video_id;
  if (!videoId) throw new Error(`HeyGen non ha restituito video_id: ${JSON.stringify(genRes.data)}`);

  logger.info(`HeyGen: video_id=${videoId} — polling ogni ${POLL_INTERVAL_MS / 1000}s`);

  // ── 2. Polling GET /v2/videos/{video_id} ─────────────────────────────────
  for (let i = 1; i <= POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await axios.get(`${BASE}/v2/videos/${videoId}`, { headers });
    const data   = statusRes.data?.data || statusRes.data || {};
    const status = data.status;
    const url    = data.video_url || data.url;

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
