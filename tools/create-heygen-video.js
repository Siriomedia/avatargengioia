/**
 * CREATE HEYGEN VIDEO
 * Genera un video con HeyGen partendo dal testo parlato.
 * Fa polling fino a completamento (max 10 minuti).
 * Restituisce l'URL pubblico del video .mp4.
 */

import axios  from 'axios';
import 'dotenv/config';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const BASE    = config.heygen.baseUrl;
const headers = {
  'X-Api-Key':     config.heygen.apiKey,
  'Content-Type':  'application/json',
};

const POLL_INTERVAL_MS = 10_000;  // 10 secondi
const POLL_MAX         = 60;      // 10 minuti max

export async function createHeygenVideo(scriptText) {
  if (!config.heygen.apiKey) throw new Error('HEYGEN_API_KEY mancante nel .env');
  if (!config.heygen.avatarId) throw new Error('HEYGEN_AVATAR_ID mancante nel .env');
  if (!config.heygen.voiceId)  throw new Error('HEYGEN_VOICE_ID mancante nel .env');

  // ── 1. Invia richiesta di generazione ────────────────────────────────────
  // motion_mode: 'normal' = Avatar IV (premium), 'standard' = Avatar III
  const motionMode    = config.heygen.motionEngine === '4' ? 'normal' : 'standard';
  const aspectRatio   = process.env.HEYGEN_ASPECT_RATIO              || '9:16';
  const exprIntensity = parseFloat(process.env.HEYGEN_EXPRESSION_INTENSITY ?? 0.3);
  const avatarStyle   = process.env.HEYGEN_AVATAR_STYLE              || 'normal';
  const bgColor       = process.env.HEYGEN_BG_COLOR                  || '#1a1a1a';
  const voiceSpeed    = parseFloat(process.env.HEYGEN_VOICE_SPEED    ?? 1.0);
  const voicePitch    = parseInt(process.env.HEYGEN_VOICE_PITCH      ?? 0, 10);
  const voiceEmotion  = process.env.HEYGEN_VOICE_EMOTION             || '';
  const voiceLocale   = process.env.HEYGEN_VOICE_LOCALE              || '';
  const bgType        = process.env.HEYGEN_BG_TYPE                   || 'color';
  const bgImageUrl    = process.env.HEYGEN_BG_IMAGE_URL              || '';
  const bgPlayStyle   = process.env.HEYGEN_BG_PLAY_STYLE             || 'loop';
  const circleBgColor = process.env.HEYGEN_CIRCLE_BG_COLOR           || '#000000';
  const offsetX       = parseFloat(process.env.HEYGEN_AVATAR_OFFSET_X ?? 0);
  const offsetY       = parseFloat(process.env.HEYGEN_AVATAR_OFFSET_Y ?? 0);
  const caption       = process.env.HEYGEN_CAPTION === 'true';
  const videoTitle    = process.env.HEYGEN_VIDEO_TITLE               || '';

  // Costruisci background
  let background;
  if (bgType === 'image' && bgImageUrl) {
    background = { type: 'image', url: bgImageUrl };
  } else if (bgType === 'video' && bgImageUrl) {
    background = { type: 'video', url: bgImageUrl, play_style: bgPlayStyle };
  } else {
    background = { type: 'color', value: bgColor };
  }

  // Costruisci voice object
  const voiceObj = {
    type:       'text',
    input_text: scriptText,
    voice_id:   config.heygen.voiceId,
    speed:      voiceSpeed,
    pitch:      voicePitch,
  };
  if (voiceEmotion) voiceObj.emotion = voiceEmotion;
  if (voiceLocale)  voiceObj.locale  = voiceLocale;

  // Costruisci character object
  const characterObj = {
    type:                 'avatar',
    avatar_id:            config.heygen.avatarId,
    avatar_style:         avatarStyle,
    motion_mode:          motionMode,
    expression_intensity: exprIntensity,
  };
  if (avatarStyle === 'circle' && circleBgColor) characterObj.circle_background_color = circleBgColor;
  if (offsetX !== 0 || offsetY !== 0) characterObj.offset = { x: offsetX, y: offsetY };

  const payload = {
    video_inputs: [{ character: characterObj, voice: voiceObj, background }],
    aspect_ratio: aspectRatio,
    caption,
    test: config.isDev,
  };
  if (videoTitle) payload.title = videoTitle;

  logger.info(`HeyGen: avvio generazione video (test=${config.isDev}, motionEngine=Avatar ${config.heygen.motionEngine})`);

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
