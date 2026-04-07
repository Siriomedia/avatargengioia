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
  const motionMode = config.heygen.motionEngine === '4' ? 'normal' : 'standard';

  const payload = {
    video_inputs: [
      {
        character: {
          type:         'avatar',
          avatar_id:    config.heygen.avatarId,
          avatar_style: 'normal',
          motion_mode:  motionMode,
        },
        voice: {
          type:       'text',
          input_text: scriptText,
          voice_id:   config.heygen.voiceId,
        },
        background: {
          type:  'color',
          value: '#1a1a1a',
        },
      },
    ],
    aspect_ratio: '9:16',
    test: config.isDev,   // In DEV usa crediti di test (watermark)
  };

  logger.info(`HeyGen: avvio generazione video (test=${config.isDev}, motionEngine=Avatar ${config.heygen.motionEngine})`);

  const genRes = await axios.post(`${BASE}/v2/video/generate`, payload, { headers });
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
