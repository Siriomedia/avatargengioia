/**
 * SELECT TOPIC
 * Legge il primo topic con status "pending" da config/topics.json
 * e lo marca come "in-progress" per evitare doppie esecuzioni.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const projectDir  = path.join(__dirname, '..');
// Rispetta DATA_DIR come server.js (volume Railway o cartella locale)
const DATA_DIR    = process.env.DATA_DIR || null;
const DEFAULT_TOPICS_FILE = DATA_DIR
  ? path.join(DATA_DIR, 'topics.json')
  : path.join(projectDir, 'config', 'topics.json');

function readTopicsFromFile(topicsFile) {
  if (!fs.existsSync(topicsFile)) return [];
  try { return JSON.parse(fs.readFileSync(topicsFile, 'utf8')); }
  catch { return []; }
}

function saveTopicsToFile(topicsFile, topics) {
  fs.writeFileSync(topicsFile, JSON.stringify(topics, null, 2));
}

/**
 * Seleziona il primo topic pending e lo marca in-progress.
 * @param {string|null} topicsFilePath - Percorso opzionale al file topics (multi-user).
 *                                       Se null usa il percorso predefinito (DATA_DIR).
 */
export async function selectTopic(topicsFilePath = null) {
  const tFile  = topicsFilePath || DEFAULT_TOPICS_FILE;
  const topics = readTopicsFromFile(tFile);

  const item = topics.find(t => t.status === 'pending');
  if (!item) return null;

  // Marca come in-progress: impedisce una doppia esecuzione
  item.status = 'in-progress';
  saveTopicsToFile(tFile, topics);

  return { ...item };
}
