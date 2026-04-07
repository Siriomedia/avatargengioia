# AvatarGenGioIA — MCP Video Pipeline

Sistema di automazione per la generazione e pubblicazione di Reel Instagram per **AvatarGenGioIA**.

Zero intervento manuale dopo il setup. Il cron genera, produce e pubblica 3 reel a settimana.

---

## Stack

| Componente | Tool |
|---|---|
| Orchestratore | Claude Cowork + MCP Server (Node.js) |
| Script generation | Claude API (claude-sonnet-4) |
| Video avatar | HeyGen API v2 |
| Post-produzione | FFmpeg |
| Scheduler | node-cron |
| Distribuzione | Meta Graph API (Instagram) |
| Database editoriale | Google Sheets |

---

## Setup rapido

### 1. Clona e installa
```bash
git clone <repo>
cd avatargengoia
npm install
```

### 2. Configura le variabili d'ambiente
```bash
cp .env.example .env
# Apri .env e compila tutti i valori
```

### 3. Ottieni le credenziali HeyGen
- Vai su [app.heygen.com](https://app.heygen.com) → Settings → API
- Genera una nuova API key
- Crea o seleziona il tuo avatar
- Esegui il test per ottenere avatar_id e voice_id automaticamente

### 4. Testa ogni componente
```bash
# Testa HeyGen (recupera avatar_id e voice_id, genera video di prova)
node tools/test-heygen.js

# Testa Claude (genera 3 script di esempio)
node tools/test-claude.js

# Testa il pipeline completo (fine-to-fine senza pubblicare)
node tools/test-pipeline.js
```

### 5. Avvia il sistema
```bash
# Produzione (cron lun/mer/ven 9:30)
node index.js

# Test immediato (esegue un ciclo adesso)
RUN_NOW=1 node index.js
```

---

## Struttura del progetto

```
avatargengoia/
├── index.js                  # Entry point + cron
├── .env.example              # Template variabili
├── .env                      # Variabili reali (non su git)
├── config/
│   ├── index.js              # Configurazione centrale
│   └── logger.js             # Logger su file
├── tools/
│   ├── test-heygen.js        # Test API HeyGen
│   ├── test-claude.js        # Test generazione script
│   ├── test-pipeline.js      # Test pipeline completo
│   ├── select-topic.js       # Legge topic da Google Sheet
│   ├── generate-script.js    # Genera script con Claude
│   ├── create-heygen-video.js # Chiama HeyGen API
│   ├── assemble-reel.js      # Monta video + foto con FFmpeg
│   └── publish-instagram.js  # Pubblica su Instagram
├── assets/
│   └── photos/               # Foto reali del prodotto
│       ├── deposito_01.jpg
│       ├── pallet_faggio_01.jpg
│       └── ...
└── logs/
    └── pipeline-YYYY-MM-DD.log
```

---

## Google Sheet — struttura richiesta

| Colonna | Descrizione |
|---|---|
| `data_pubblicazione` | Data prevista (es. 2026-04-07) |
| `topic` | Tema del video (es. "essiccazione naturale") |
| `pilastro` | tecnico / prodotto / servizio / economico |
| `photo_id` | Nome file foto (es. `pallet_faggio_01.jpg`) |
| `script_status` | vuoto → generato → approvato |
| `video_url` | Compilato automaticamente dal sistema |
| `post_status` | schedulato / pubblicato / errore |
| `instagram_permalink` | URL del post pubblicato |

---

## Aggiungere topic nuovi

1. Apri il Google Sheet
2. Aggiungi una riga con data, topic, pilastro e photo_id
3. Il sistema la processa automaticamente alla prossima esecuzione

---

## Build status

- [x] Step 1: Struttura progetto + test HeyGen
- [ ] Step 2: `select-topic.js` (Google Sheets)
- [ ] Step 3: `generate-script.js` (Claude API)
- [ ] Step 4: `create-heygen-video.js` (HeyGen API)
- [ ] Step 5: `assemble-reel.js` (FFmpeg)
- [ ] Step 6: `publish-instagram.js` (Meta API)
- [ ] Step 7: Cowork plugin + cron produzione
