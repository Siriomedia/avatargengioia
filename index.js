/**
 * 2C LEGNAMI MCP — Entry point
 * Avvia il cron scheduler del pipeline video
 *
 * Uso:
 *   node index.js           → avvia il cron (produzione)
 *   RUN_NOW=1 node index.js → esegue subito un ciclo (test)
 */

import cron from 'node-cron';
import { config } from './config/index.js';
import { logger } from './config/logger.js';

logger.info('══════════════════════════════════════');
logger.info('  2C LEGNAMI — MCP PIPELINE AVVIATO');
logger.info('══════════════════════════════════════');
logger.info(`Ambiente: ${config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
logger.info(`Schedule: ${config.cron.schedule}`);

// Import lazy dei tool (costruiti negli step successivi)
async function runPipeline() {
  logger.info('─── Avvio ciclo pipeline ───');

  try {
    // Step 1: seleziona topic dal Google Sheet
    const { selectTopic } = await import('./tools/select-topic.js');
    const item = await selectTopic();
    if (!item) {
      logger.warn('Nessun topic disponibile — pipeline saltata');
      return;
    }
    logger.info(`Topic selezionato: "${item.topic}" [${item.pilastro}]`);

    // Step 2: genera script con Claude
    const { generateScript } = await import('./tools/generate-script.js');
    const script = await generateScript(item.topic, item.pilastro);
    logger.info(`Script generato: ${script.length} caratteri`);

    // Step 3: crea video HeyGen
    const { createHeygenVideo } = await import('./tools/create-heygen-video.js');
    const videoUrl = await createHeygenVideo(script);
    logger.success(`Video pronto: ${videoUrl}`);

    // Step 4: assembla reel con foto
    const { assembleReel } = await import('./tools/assemble-reel.js');
    const reelPath = await assembleReel(videoUrl, item.photoId, script);
    logger.success(`Reel assemblato: ${reelPath}`);

    // Step 5: pubblica su Instagram
    const { publishInstagram } = await import('./tools/publish-instagram.js');
    const permalink = await publishInstagram(reelPath, item);
    logger.success(`Pubblicato: ${permalink}`);

  } catch (err) {
    logger.error(`Pipeline fallita: ${err.message}`);
    logger.error(err.stack);
  }
}

// Esecuzione immediata se RUN_NOW=1
if (process.env.RUN_NOW === '1') {
  logger.info('RUN_NOW attivo — esecuzione immediata');
  await runPipeline();
} else {
  // Cron scheduler
  cron.schedule(config.cron.schedule, () => {
    logger.info(`Cron triggered: ${new Date().toISOString()}`);
    runPipeline();
  }, {
    timezone: 'Europe/Rome',
  });

  logger.info(`Scheduler attivo. Prossima esecuzione: ${config.cron.schedule} (Europe/Rome)`);
  logger.info('Premi Ctrl+C per fermare.');
}
