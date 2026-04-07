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

// System prompt calibrato su AvatarGenGioIA
// Basato sugli script tecnici già approvati nelle sessioni ChatGPT
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

const TEST_TOPICS = [
  { topic: 'essiccazione naturale vs forno', pilastro: 'tecnico' },
  { topic: 'perché scegliere il Faggio Premium per la pizza napoletana', pilastro: 'prodotto' },
  { topic: 'consegna 24h e stabilità del servizio', pilastro: 'servizio' },
];

async function generateScript(topic, pilastro) {
  const userPrompt = `Genera uno script video per Instagram Reel su questo tema:

TOPIC: ${topic}
PILASTRO EDITORIALE: ${pilastro}

Lo script deve essere parlato dall'avatar di AvatarGenGioIA, direttamente rivolto al pizzaiolo professionista.`;

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
