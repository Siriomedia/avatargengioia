/**
 * CREATE HEYGEN VIDEO
 * API HeyGen POST /v2/videos — polling su GET /v2/videos/{video_id}
 *
 * Principio: la configurazione e' la legge.
 * Tutti i parametri vengono letti da process.env al momento della chiamata.
 */

import axios from 'axios';
import { logger } from '../config/logger.js';

const BASE             = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX         = 60;

function intensityToExpressiveness(val) {
  if (val <= 0.33) return 'low';
  if (val <= 0.66) return 'medium';
  return 'high';
}

function readHeygenConfig() {
  const rawIntensity = parseFloat(process.env.HEYGEN_EXPRESSION_INTENSITY ?? 0.3);
  return {
    apiKey:           process.env.HEYGEN_API_KEY,
    avatarId:         process.env.HEYGEN_AVATAR_ID,
    voiceId:          process.env.HEYGEN_VOICE_ID,
    useAvatarIV:      process.env.HEYGEN_MOTION_ENGINE === '4',
    aspectRatio:      process.env.HEYGEN_ASPECT_RATIO      || '9:16',
    resolution:       process.env.HEYGEN_RESOLUTION        || '1080p',
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
    testMode:         process.env.HEYGEN_TEST_MODE          === 'true',
  };
}

/**
 * Costruisce il payload JSON per POST /v2/videos.
 * Esportata per usarla nell'endpoint /api/heygen/debug-payload senza chiamare HeyGen.
 */
export function buildHeygenPayload(scriptText) {
  const cfg = readHeygenConfig();

  const safeImageUrl = cfg.bgImageUrl && !cfg.bgImageUrl.startsWith('data:') ? cfg.bgImageUrl : '';
  let background;
  if (cfg.bgType === 'image' && safeImageUrl) {
    background = { type: 'image', url: safeImageUrl };
  } else if (cfg.bgType === 'video' && safeImageUrl) {
    background = { type: 'video', url: safeImageUrl, play_style: cfg.bgPlayStyle };
  } else {
    background = { type: 'color', value: cfg.bgColor };
  }

  const voiceSettings = {};
  if (cfg.voiceSpeed !== 1.0)  voiceSettings.speed   = cfg.voiceSpeed;
  if (cfg.voicePitch !== 0)    voiceSettings.pitch   = cfg.voicePitch;
  if (cfg.voiceLocale)         voiceSettings.locale  = cfg.voiceLocale;
  if (cfg.voiceEmotion)        voiceSettings.emotion = cfg.voiceEmotion;

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

  if (cfg.useAvatarIV)                   payload.use_avatar_iv_model = true;
  if (cfg.motionPrompt)                  payload.motion_prompt       = cfg.motionPrompt;
  if (cfg.videoTitle)                    payload.title               = cfg.videoTitle;
  if (Object.keys(voiceSettings).length) payload.voice_settings      = voiceSettings;

  return { cfg, payload };
}

export async function createHeygenVideo(scriptText) {
  const { cfg, payload } = buildHeygenPayload(scriptText);

  if (!cfg.apiKey)   throw new Error('HEYGEN_API_KEY mancante nella configurazione');
  if (!cfg.avatarId) throw new Error('HEYGEN_AVATAR_ID mancante nella configurazione');
  if (!cfg.voiceId)  throw new Error('HEYGEN_VOICE_ID mancante nella configurazione');

  logger.info('━━━ HeyGen process.env al momento della chiamata ━━━━━━━━━━━');
  logger.info(`  HEYGEN_AVATAR_ID      : ${process.env.HEYGEN_AVATAR_ID}`);
  logger.info(`  HEYGEN_VOICE_ID       : ${process.env.HEYGEN_VOICE_ID}`);
  logger.info(`  HEYGEN_MOTION_ENGINE  : ${process.env.HEYGEN_MOTION_ENGINE} -> use_avatar_iv_model: ${cfg.useAvatarIV}`);
  logger.info(`  HEYGEN_ASPECT_RATIO   : ${process.env.HEYGEN_ASPECT_RATIO}`);
  logger.info(`  HEYGEN_RESOLUTION     : ${process.env.HEYGEN_RESOLUTION}`);
  logger.info(`  HEYGEN_EXPRESSIVENESS : ${process.env.HEYGEN_EXPRESSIVENESS}`);
  logger.info(`  HEYGEN_VOICE_EMOTION  : ${process.env.HEYGEN_VOICE_EMOTION}`);
  logger.info(`  HEYGEN_VOICE_LOCALE   : ${process.env.HEYGEN_VOICE_LOCALE}`);
  logger.info(`  HEYGEN_TEST_MODE      : ${process.env.HEYGEN_TEST_MODE}`);
  logger.info('━━━ PAYLOAD JSON -> POST /v2/videos ━━━━━━━━━━━━━━━━━━━━━━━━');
  const logPayload = { ...payload, script: `[${(payload.script || '').length} chars]` };
  logger.info(JSON.stringify(logPayload, null, 2));
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const headers = { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json' };

  let genRes;
  try {
    genRes = await axios.post(`${BASE}/v2/videos`, payload, { headers });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`HeyGen POST /v2/videos -> ${err.response?.status ?? '?'}: ${detail}`);
  }
  const videoId = genRes.data?.data?.video_id || genRes.data?.video_id;
  if (!videoId) throw new Error(`HeyGen non ha restituito video_id: ${JSON.stringify(genRes.data)}`);

  logger.info(`HeyGen: video_id=${videoId} — polling ogni ${POLL_INTERVAL_MS / 1000}s`);

  for (let i = 1; i <= POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await axios.get(`${BASE}/v2/videos/${videoId}`, { headers });
    const data   = statusRes.data?.data || statusRes.data || {};
    const status = data.status;
    const url    = data.video_url || data.url;

    logger.info(`HeyGen polling [${i * 10}s]: ${status}`);

    if (status === 'completed' && url) {
      logger.info(`HeyGen: video completato -> ${url}`);
      return url;
    }

    if (status === 'failed') {
      throw new Error(`HeyGen video fallito: ${JSON.stringify(data.error || data)}`);
    }
  }

  throw new Error(`HeyGen: timeout dopo ${(POLL_MAX * POLL_INTERVAL_MS) / 60000} minuti`);
}
