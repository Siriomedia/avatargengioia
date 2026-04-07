/**
 * GENERATE SCRIPT
 * Se il topic ha già il campo "parlato" compilato nell'Excel,
 * lo usa direttamente (nessuna chiamata Claude).
 * Altrimenti genera lo script con Claude Sonnet.
 */

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

// System prompt calibrato su AvatarGenGioIA
const SYSTEM_PROMPT = `Sei il sistema di generazione script per AvatarGenGioIA, fornitore professionale di legna per pizzerie dal 2000.

IDENTITÀ DEL BRAND:
- Partner tecnico di stabilità forno, non semplice venditore di legna
- Ebanisti da 3 generazioni — conoscenza profonda del legno
- 200+ pizzerie servite, consegna 24h, filiera certificata

PRODOTTI REALI (usa questi nomi esatti):
- Faggio Premium Decortecciato: legna senza corteccia, essiccata, <20% umidità, 48-52cm, per pizza napoletana
- Quercia Lenta: brace duratura, stagionatura 16 mesi, per forni stazionari, €14/qlē
- Misto Professionale: blend faggio+carpino, best seller, avvio rapido + brace persistente, €13/qlē
- Carbone Vegetale: grigliate professionali, €1,30/kg

TONO DI VOCE — REGOLE FERREE:
1. Tecnico e asciutto — nessuna iperbole, nessun aggettivo vuoto
2. Frasi corte, ritmo secco
3. Un concetto per frase
4. MAI: "la migliore", "eccezionale", "straordinario", "unico nel suo genere"
5. SÌ: dati concreti, processi specifici, risultati misurabili
6. Struttura sempre: problema/contesto → processo 2C → risultato concreto → CTA

CTA FINALE FISSA (sempre identica, parola per parola):
"Se vuoi provare la nostra legna, contattaci."

ESEMPI DI TONO CORRETTO:
"La legna umida crea variazioni di temperatura nel forno. Ogni nostro lotto viene testato con igrometro: umidità residua sotto il 20%. Il forno lavora in modo costante."

"Nel forno professionale la pezzatura non è casuale. I nostri quadrotti misurano 48-52 cm, calibrati per la bocca standard dei forni da pizzeria."

FORMATO OUTPUT:
- Solo il testo parlato, pronto per HeyGen
- Durata target: 30-45 secondi (circa 80-120 parole)
- Nessun titolo, nessuna nota, solo il parlato
- Termina SEMPRE con la CTA fissa`;

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

  const userPrompt = `Genera uno script video per Instagram Reel su questo tema:

TOPIC: ${topic}
PILASTRO EDITORIALE: ${pilastro}

Lo script deve essere parlato dall'avatar di AvatarGenGioIA, direttamente rivolto al pizzaiolo professionista.`;

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text;
}
