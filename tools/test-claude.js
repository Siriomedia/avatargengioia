/**
 * TEST CLAUDE — Step 1
 * Esegui: node tools/test-claude.js
 *
 * Verifica che Claude generi script corretti
 * con il tono tecnico di AvatarGenGioIA
 */

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// System prompt universale — adatto a qualsiasi argomento
const SYSTEM_PROMPT = `Sei un sistema esperto di generazione script per video brevi (Instagram Reel, TikTok, YouTube Short).
Il tuo compito è scrivere il testo parlato dell'avatar, calibrato sull'argomento specifico del topic.

REGOLE DI STILE — FERREE:
1. Tono professionale e diretto, adattato all'argomento
2. Frasi corte, ritmo secco
3. Un concetto per frase
4. MAI: "la migliore", "eccezionale", "straordinario", "unico nel suo genere"
5. SÌ: dati concreti, processi specifici, risultati misurabili
6. Struttura sempre: problema/contesto → soluzione/processo → risultato concreto → CTA

FORMATO OUTPUT:
- Solo il testo parlato, pronto per HeyGen
- Durata target: 30-45 secondi (circa 80-120 parole)
- Nessun titolo, nessuna nota, solo il parlato
- Termina con una call-to-action appropriata al contesto`;

const TEST_TOPICS = [
  { topic: 'come l\'intelligenza artificiale sta cambiando il lavoro nel 2025', pilastro: 'educativo' },
  { topic: '3 errori comuni quando si parla di sostenibilità', pilastro: 'opinione' },
  { topic: 'come usare ChatGPT per risparmiare 2 ore al giorno', pilastro: 'tutorial' },
];

async function generateScript(topic, pilastro) {
  const userPrompt = `Genera uno script video per Instagram Reel su questo tema:

TOPIC: ${topic}
PILASTRO EDITORIALE: ${pilastro}

Lo script deve essere parlato dall'avatar di AvatarGenGioIA, rivolto direttamente al pubblico target di questo contenuto.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text;
}

async function main() {
  console.log('══════════════════════════════════════');
  console.log('  AvatarGenGioIA — TEST CLAUDE SCRIPT');
  console.log('══════════════════════════════════════\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌  ANTHROPIC_API_KEY mancante nel .env');
    process.exit(1);
  }

  for (const { topic, pilastro } of TEST_TOPICS) {
    console.log(`─── Topic: "${topic}" [${pilastro}] ───\n`);
    try {
      const script = await generateScript(topic, pilastro);
      console.log(script);
      console.log('\n' + '─'.repeat(50) + '\n');
    } catch (e) {
      console.error(`❌  Errore: ${e.message}`);
    }
  }

  console.log('✅  Test Claude completato.');
  console.log('Prossimo step: node tools/test-pipeline.js');
}

main().catch(console.error);
