/**
 * GENERATE SCRIPT
 * Se il topic ha già il campo "parlato" compilato nell'Excel,
 * lo usa direttamente (nessuna chiamata Claude).
 * Altrimenti genera lo script con Claude Sonnet.
 */

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

// System prompt universale — adatto a qualsiasi argomento
const SYSTEM_PROMPT = `Sei un sistema esperto di generazione script per video brevi (Instagram Reel, TikTok, YouTube Short).
Il tuo compito è scrivere il testo parlato dell'avatar, calibrato sull'argomento specifico del topic.

REGOLE DI STILE — FERREE:
1. Tono professionale e diretto, adattato all'argomento (tecnico per scienza, autorevole per politica, ecc.)
2. Frasi corte, ritmo secco
3. Un concetto per frase
4. MAI: "la migliore", "eccezionale", "straordinario", "unico nel suo genere"
5. SÌ: dati concreti, processi specifici, risultati misurabili
6. Struttura sempre: problema/contesto → soluzione/processo → risultato concreto → CTA

FORMATO OUTPUT:
- Solo il testo parlato, pronto per HeyGen
- Durata target: 30-45 secondi (circa 80-120 parole)
- Nessun titolo, nessuna nota, solo il parlato
- Termina sempre con una call-to-action appropriata al contesto e al pilastro editoriale`;

/**
 * @param {string} topic    - Argomento del video
 * @param {string} pilastro - Categoria editoriale
 * @param {string} parlato  - Testo pre-scritto nell'Excel (opzionale)
 * @returns {Promise<string>} Testo parlato pronto per HeyGen
 */
export async function generateScript(topic, pilastro, parlato = '') {
  // ── Caso 1: parlato già scritto nel file Excel ────────────────────────────
  if (parlato && parlato.trim().length > 20) {
    return parlato.trim();
  }

  // ── Caso 2: genera con Claude AI ─────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY mancante nel .env');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userPrompt = `Genera uno script video per questo topic:

TOPIC: ${topic}
PILASTRO EDITORIALE: ${pilastro}

Lo script deve essere parlato dall'avatar, rivolto direttamente al pubblico target di questo contenuto.`;

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text;
}
