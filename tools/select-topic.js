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
const TOPICS_FILE = DATA_DIR
  ? path.join(DATA_DIR, 'topics.json')
  : path.join(projectDir, 'config', 'topics.json');

function readTopics() {
  if (!fs.existsSync(TOPICS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); }
  catch { return []; }
}

function saveTopics(topics) {
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2));
}

export async function selectTopic() {
  const topics = readTopics();

  const item = topics.find(t => t.status === 'pending');
  if (!item) return null;

  // Marca come in-progress: impedisce una doppia esecuzione
  item.status = 'in-progress';
  saveTopics(topics);

  return { ...item };
}
