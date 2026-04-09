/**
 * GENERATE SCRIPT
 * Se il topic ha già il campo "parlato" compilato nell'Excel,
 * lo usa direttamente (nessuna chiamata AI).
 * Altrimenti genera lo script con Google Gemini.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
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

  // ── Caso 2: genera con Gemini AI ──────────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY mancante nel .env');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model  = genAI.getGenerativeModel({
    model:             process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const userPrompt = `Genera uno script video per questo topic:

TOPIC: ${topic}
PILASTRO EDITORIALE: ${pilastro}

Lo script deve essere parlato dall'avatar, rivolto direttamente al pubblico target di questo contenuto.`;

  const result = await model.generateContent(userPrompt);
  return result.response.text();
}
