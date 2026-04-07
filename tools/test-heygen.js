/**
 * TEST HEYGEN — Step 1
 * Esegui: node tools/test-heygen.js
 *
 * Cosa fa:
 * 1. Verifica che la API key sia valida
 * 2. Recupera l'avatar già creato e mostra il suo ID
 * 3. Recupera le voci italiane disponibili
 * 4. Genera un video di test di 10 secondi
 */

import 'dotenv/config';
import axios from 'axios';

const API_KEY = process.env.HEYGEN_API_KEY;
const BASE = 'https://api.heygen.com';

if (!API_KEY || API_KEY.includes('...')) {
  console.error('❌  HEYGEN_API_KEY mancante nel .env');
  process.exit(1);
}

const headers = {
  'X-Api-Key': API_KEY,
  'Content-Type': 'application/json',
};

// ─── 1. INFO ACCOUNT ───────────────────────────────────────────────
async function checkAccount() {
  console.log('\n─── 1. Verifica account ───');
  try {
    const res = await axios.get(`${BASE}/v2/user/remaining_quota`, { headers });
    console.log('✅  Account valido');
    console.log('    Quota rimanente:', JSON.stringify(res.data?.data, null, 2));
  } catch (e) {
    console.error('❌  API key non valida o quota esaurita');
    console.error('    Status:', e.response?.status);
    console.error('    Errore:', e.response?.data);
    process.exit(1);
  }
}

// ─── 2. LISTA AVATAR ───────────────────────────────────────────────
async function listAvatars() {
  console.log('\n─── 2. Avatar disponibili ───');
  try {
    const res = await axios.get(`${BASE}/v2/avatars`, { headers });
    const avatars = res.data?.data?.avatars || [];

    if (avatars.length === 0) {
      console.warn('⚠️  Nessun avatar trovato. Crea prima un avatar su app.heygen.com');
      return null;
    }

    console.log(`✅  Trovati ${avatars.length} avatar:\n`);
    avatars.forEach((a, i) => {
      console.log(`  [${i + 1}] Nome: ${a.avatar_name}`);
      console.log(`       ID:   ${a.avatar_id}`);
      console.log(`       Tipo: ${a.avatar_type || 'standard'}\n`);
    });

    const first = avatars[0];
    console.log(`💡  Copia nel .env:  HEYGEN_AVATAR_ID=${first.avatar_id}`);
    return first.avatar_id;
  } catch (e) {
    console.error('❌  Errore nel recupero avatar:', e.response?.data);
    return null;
  }
}

// ─── 3. LISTA VOCI ITALIANE ────────────────────────────────────────
async function listItalianVoices() {
  console.log('\n─── 3. Voci italiane disponibili ───');
  try {
    const res = await axios.get(`${BASE}/v2/voices`, { headers });
    const voices = res.data?.data?.voices || [];

    const italian = voices.filter(v =>
      v.language?.toLowerCase().includes('italian') ||
      v.locale?.toLowerCase().includes('it') ||
      v.name?.toLowerCase().includes('italian')
    );

    if (italian.length === 0) {
      console.warn('⚠️  Nessuna voce italiana trovata. Voci disponibili:');
      voices.slice(0, 5).forEach(v => {
        console.log(`  - ${v.name} (${v.language || v.locale}) → ${v.voice_id}`);
      });
      return voices[0]?.voice_id || null;
    }

    console.log(`✅  Trovate ${italian.length} voci italiane:\n`);
    italian.forEach((v, i) => {
      console.log(`  [${i + 1}] ${v.name} (${v.language || v.locale})`);
      console.log(`       ID: ${v.voice_id}\n`);
    });

    const first = italian[0];
    console.log(`💡  Copia nel .env:  HEYGEN_VOICE_ID=${first.voice_id}`);
    return first.voice_id;
  } catch (e) {
    console.error('❌  Errore nel recupero voci:', e.response?.data);
    return null;
  }
}

// ─── 4. VIDEO DI TEST ──────────────────────────────────────────────
async function generateTestVideo(avatarId, voiceId) {
  if (!avatarId || !voiceId) {
    console.log('\n⏭️  Salto video di test (avatar_id o voice_id mancante)');
    return;
  }

  console.log('\n─── 4. Generazione video di test ───');
  console.log('   Avatar:', avatarId);
  console.log('   Voce:  ', voiceId);

  const payload = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: 'Ciao. Sono il sistema automatico di AvatarGenGioIA. Test completato.',
          voice_id: voiceId,
        },
        background: {
          type: 'color',
          value: '#1a1a1a',
        },
      },
    ],
    aspect_ratio: '9:16',
    test: true,
  };

  try {
    console.log('\n   Invio richiesta a HeyGen...');
    const res = await axios.post(`${BASE}/v2/video/generate`, payload, { headers });
    const videoId = res.data?.data?.video_id;

    if (!videoId) {
      console.error('❌  Nessun video_id nella risposta:', res.data);
      return;
    }

    console.log(`✅  Video avviato! ID: ${videoId}`);
    console.log('   Attendo completamento (polling ogni 10s)...\n');

    // Polling
    let attempts = 0;
    while (attempts < 24) { // max 4 minuti
      await new Promise(r => setTimeout(r, 10000));
      attempts++;

      const status = await axios.get(`${BASE}/v1/video_status.get?video_id=${videoId}`, { headers });
      const s = status.data?.data?.status;
      const url = status.data?.data?.video_url;

      process.stdout.write(`   [${attempts * 10}s] Status: ${s}\r`);

      if (s === 'completed' && url) {
        console.log(`\n\n✅  Video completato!`);
        console.log(`   URL: ${url}\n`);
        console.log('🎉  SETUP STEP 1 COMPLETATO — tutto funziona correttamente.\n');
        return;
      }

      if (s === 'failed') {
        console.error('\n❌  Video fallito:', status.data?.data?.error);
        return;
      }
    }

    console.log('\n⏱️  Timeout — il video è ancora in elaborazione.');
    console.log(`   Controlla manualmente su: https://app.heygen.com (video ID: ${videoId})`);

  } catch (e) {
    console.error('❌  Errore generazione video:', e.response?.data || e.message);
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════');
  console.log('  AvatarGenGioIA — TEST HEYGEN API');
  console.log('══════════════════════════════════════');

  await checkAccount();
  const avatarId = await listAvatars();
  const voiceId = await listItalianVoices();
  await generateTestVideo(avatarId, voiceId);

  console.log('\n─────────────────────────────────────');
  console.log('Prossimo step: compila .env con i valori trovati sopra,');
  console.log('poi esegui: node tools/test-claude.js');
  console.log('─────────────────────────────────────\n');
}

main().catch(e => {
  console.error('Errore fatale:', e.message);
  process.exit(1);
});
