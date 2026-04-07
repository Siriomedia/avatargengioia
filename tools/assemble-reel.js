/**
 * ASSEMBLE REEL
 * Scarica il video HeyGen, lo combina con la foto del prodotto
 * usando ffmpeg, e genera il reel finale in assets/output/.
 *
 * Struttura output:
 *   assets/output/reel-<timestamp>.mp4
 *
 * Layout:
 *   - Parte superiore (70%): video avatar HeyGen
 *   - Parte inferiore (30%): foto prodotto con overlay testo
 *   Se photoId non è presente: solo il video avatar a schermo intero
 */

import ffmpeg          from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import axios           from 'axios';
import fs              from 'fs';
import path            from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { config }  from '../config/index.js';
import { logger }  from '../config/logger.js';

// Punta al binario ffmpeg bundled (non serve installazione di sistema)
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR    = process.env.DATA_DIR;
const OUTPUT_DIR  = DATA_DIR ? path.join(DATA_DIR, 'output') : path.join(__dirname, '../assets/output');
const PHOTOS_DIR  = DATA_DIR && process.env.PHOTOS_BASE_PATH
  ? path.resolve(process.env.PHOTOS_BASE_PATH)
  : path.resolve(config.photos.basePath);

// Assicura che la cartella output esista
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Scarica un file remoto in una path locale temporanea.
 */
async function downloadFile(url, destPath) {
  logger.info(`Download: ${url}`);
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(destPath, Buffer.from(res.data));
  logger.info(`Salvato: ${destPath}`);
}

/**
 * @param {string} videoUrl  - URL pubblico del video HeyGen
 * @param {string} photoId   - Nome file foto (es. faggio.jpg) in assets/photos/
 * @param {string} script    - Testo parlato (usato per eventuale sottotitolo futuro)
 * @returns {Promise<string>} Path assoluto del reel finale
 */
export async function assembleReel(videoUrl, photoId, script) {
  const ts        = Date.now();
  const tmpVideo  = path.join(OUTPUT_DIR, `tmp-heygen-${ts}.mp4`);
  const outPath   = path.join(OUTPUT_DIR, `reel-${ts}.mp4`);

  // ── 1. Scarica video HeyGen ───────────────────────────────────────────────
  await downloadFile(videoUrl, tmpVideo);

  // ── 2. Cerca la foto del prodotto ────────────────────────────────────────
  const photoPath = photoId
    ? path.join(PHOTOS_DIR, photoId)
    : null;
  const hasPhoto  = photoPath && fs.existsSync(photoPath);

  if (photoId && !hasPhoto) {
    logger.warn(`Foto "${photoId}" non trovata in ${PHOTOS_DIR} — solo video`);
  }

  // ── 3. Assembla con FFmpeg ────────────────────────────────────────────────
  await new Promise((resolve, reject) => {
    if (!hasPhoto) {
      // Nessuna foto: copia diretta con ri-encode per compatibilità Instagram
      ffmpeg(tmpVideo)
        .outputOptions([
          '-vf',    'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
          '-c:v',   'libx264',
          '-preset','fast',
          '-crf',   '23',
          '-c:a',   'aac',
          '-b:a',   '128k',
          '-movflags', '+faststart',
          '-y',
        ])
        .output(outPath)
        .on('end',   resolve)
        .on('error', reject)
        .run();
    } else {
      // Con foto: video (70% alto) + foto (30% basso) in stack verticale 9:16
      ffmpeg()
        .input(tmpVideo)
        .input(photoPath)
        .complexFilter([
          // Scala video a 1080x1344 (70% di 1920)
          '[0:v]scale=1080:1344,setsar=1[top]',
          // Scala foto a 1080x576 (30% di 1920)
          '[1:v]scale=1080:576,setsar=1[bot]',
          // Stack verticale
          '[top][bot]vstack=inputs=2[out]',
        ], 'out')
        .outputOptions([
          '-c:v',   'libx264',
          '-preset','fast',
          '-crf',   '23',
          '-c:a',   'aac',
          '-b:a',   '128k',
          '-movflags', '+faststart',
          '-y',
        ])
        .output(outPath)
        .on('end',   resolve)
        .on('error', reject)
        .run();
    }
  });

  // ── 4. Pulizia file temporanei ────────────────────────────────────────────
  if (fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo);

  logger.info(`Reel assemblato: ${outPath}`);
  return outPath;
}
