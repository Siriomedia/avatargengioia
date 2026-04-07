/**
 * PUBLISH INSTAGRAM
 * Pubblica il reel su Instagram Business via Meta Graph API.
 *
 * Flusso:
 *   1. Upload del video su un server accessibile pubblicamente (usa il
 *      campo videoUrl se già disponibile, oppure carica su Meta direttamente)
 *   2. Crea container multimediale (POST /{ig-user-id}/media)
 *   3. Polling finché il container è FINISHED
 *   4. Pubblica (POST /{ig-user-id}/media_publish)
 *   5. Restituisce il permalink del post
 *
 * NOTA: Meta Graph API richiede che il file video sia raggiungibile
 * via URL pubblico. In produzione il file viene prima caricato su un
 * bucket S3/Cloudflare R2 (vedi VIDEO_CDN_BASE_URL nel .env).
 * In DEV, se VIDEO_CDN_BASE_URL non è configurato, la funzione usa
 * la URL originale di HeyGen come fallback per i test.
 */

import axios   from 'axios';
import fs      from 'fs';
import path    from 'path';
import 'dotenv/config';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const BASE    = config.meta.baseUrl;
const IG_ID   = config.meta.instagramAccountId;
const TOKEN   = config.meta.accessToken;

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX         = 60;   // 5 minuti max

/**
 * Costruisce la caption del reel.
 * La CTA fissa viene omessa dalla caption (è già nel parlato del video).
 */
function buildCaption(item) {
  const hashtags = [
    '#avatargengoia', '#videoAI', '#contentcreator',
    '#socialmedia', '#reels', '#shorts',
  ];

  const pilastroTag = {
    educativo:    '#imparare',
    opinione:     '#analisi',
    tutorial:     '#comefare',
    ispirazione:  '#motivazione',
    notizia:      '#trend',
    brand:        '#backstage',
    tecnico:      '#approfondimento',
    prodotto:     '#novità',
    servizio:     '#servizi',
  }[item.pilastro] || '#contenuti';

  return [
    item.topic,
    '',
    item.note || '',
    '',
    [pilastroTag, ...hashtags].filter(Boolean).join(' '),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim();
}

/**
 * Ottieni l'URL pubblico del video da pubblicare.
 * In produzione, il reel è già caricato su un CDN.
 * In DEV con CDN non configurato, usa l'URL diretto HeyGen (solo test).
 */
async function resolvePublicVideoUrl(reelPath) {
  const cdnBase = process.env.VIDEO_CDN_BASE_URL;
  if (cdnBase) {
    const filename = path.basename(reelPath);
    return `${cdnBase.replace(/\/$/, '')}/${filename}`;
  }

  // DEV fallback: nessun CDN configurato
  logger.warn('VIDEO_CDN_BASE_URL non configurato — il video non sarà pubblicabile su Instagram');
  logger.warn('Configura un CDN o ngrok per il publish reale.');
  // Restituisce un URL fittizio per permettere ai test di procedere
  return `https://cdn.placeholder.invalid/${path.basename(reelPath)}`;
}

export async function publishInstagram(reelPath, item) {
  if (!TOKEN)  throw new Error('META_ACCESS_TOKEN mancante nel .env');
  if (!IG_ID)  throw new Error('INSTAGRAM_ACCOUNT_ID mancante nel .env');

  const caption  = buildCaption(item);
  const videoUrl = await resolvePublicVideoUrl(reelPath);

  logger.info(`Instagram: creazione container per "${item.topic}"`);
  logger.info(`Instagram: video URL → ${videoUrl}`);

  // ── 1. Crea container media ───────────────────────────────────────────────
  const createRes = await axios.post(
    `${BASE}/${IG_ID}/media`,
    {
      media_type:   'REELS',
      video_url:    videoUrl,
      caption,
      share_to_feed: true,
    },
    { params: { access_token: TOKEN } }
  );

  const containerId = createRes.data?.id;
  if (!containerId) throw new Error(`Meta: nessun container ID: ${JSON.stringify(createRes.data)}`);

  logger.info(`Instagram: container creato → ${containerId}`);

  // ── 2. Polling stato container ────────────────────────────────────────────
  for (let i = 1; i <= POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await axios.get(
      `${BASE}/${containerId}`,
      { params: { fields: 'status_code,status', access_token: TOKEN } }
    );
    const statusCode = statusRes.data?.status_code;
    logger.info(`Instagram polling [${i * 5}s]: ${statusCode}`);

    if (statusCode === 'FINISHED') break;
    if (statusCode === 'ERROR') {
      throw new Error(`Meta container in errore: ${JSON.stringify(statusRes.data)}`);
    }
    if (i === POLL_MAX) {
      throw new Error('Meta: timeout container dopo 5 minuti');
    }
  }

  // ── 3. Pubblica ───────────────────────────────────────────────────────────
  const publishRes = await axios.post(
    `${BASE}/${IG_ID}/media_publish`,
    { creation_id: containerId },
    { params: { access_token: TOKEN } }
  );

  const mediaId = publishRes.data?.id;
  if (!mediaId) throw new Error(`Meta publish fallito: ${JSON.stringify(publishRes.data)}`);

  // ── 4. Recupera permalink ─────────────────────────────────────────────────
  const infoRes = await axios.get(
    `${BASE}/${mediaId}`,
    { params: { fields: 'permalink', access_token: TOKEN } }
  );
  const permalink = infoRes.data?.permalink || `https://www.instagram.com/p/${mediaId}/`;

  logger.info(`Instagram: pubblicato → ${permalink}`);
  return permalink;
}
