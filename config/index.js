// ⚡ Carica .env con override=true → il file .env batte le variabili di sistema/Railway
// Questo garantisce che la configurazione salvata sia SEMPRE la legge principale
import dotenv from 'dotenv';
dotenv.config({ override: true });

// Valida che le variabili critiche siano presenti
const required = {
  HEYGEN_API_KEY: process.env.HEYGEN_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

const missing = Object.entries(required)
  .filter(([, v]) => !v || v.includes('...'))
  .map(([k]) => k);

if (missing.length > 0) {
  console.warn(`⚠️  Variabili mancanti nel .env: ${missing.join(', ')}`);
}

export const config = {
  heygen: {
    apiKey:       process.env.HEYGEN_API_KEY,
    avatarId:     process.env.HEYGEN_AVATAR_ID,
    voiceId:      process.env.HEYGEN_VOICE_ID,
    motionEngine: process.env.HEYGEN_MOTION_ENGINE || '3',   // '3' = Avatar III (default), '4' = Avatar IV
    baseUrl: 'https://api.heygen.com',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  meta: {
    accessToken: process.env.META_ACCESS_TOKEN,
    instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID,
    baseUrl: 'https://graph.facebook.com/v19.0',
  },
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './config/google-credentials.json',
  },
  telegram: {
    token:  process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  photos: {
    basePath: process.env.PHOTOS_BASE_PATH || './assets/photos',
  },
  cron: {
    schedule: process.env.CRON_SCHEDULE || '30 9 * * 1,3,5',
  },
  isDev: process.env.NODE_ENV !== 'production',
};
