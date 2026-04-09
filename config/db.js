/**
 * PostgreSQL database module — AvatarGenGioIA
 *
 * Attivo SOLO quando DATABASE_URL è presente (Railway PostgreSQL plugin).
 * In locale senza DATABASE_URL, server.js usa file JSON (comportamento originale).
 *
 * Su Railway: aggiungi il plugin PostgreSQL nel tuo progetto —
 * DATABASE_URL viene iniettata automaticamente come variabile d'ambiente.
 */

import pg   from 'pg';
import fs   from 'fs';
import path from 'path';

const { Pool } = pg;
let _pool = null;

// ─── Connessione ──────────────────────────────────────────────────────────────

export function isDbEnabled() {
  return !!process.env.DATABASE_URL;
}

function pool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis:    30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', err => console.error('[DB] Pool error:', err.message));
  }
  return _pool;
}

// ─── Schema (CREATE IF NOT EXISTS) ───────────────────────────────────────────

export async function initDb() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT        PRIMARY KEY,
      email         TEXT        UNIQUE NOT NULL,
      name          TEXT        NOT NULL DEFAULT '',
      password_hash TEXT        NOT NULL,
      role          TEXT        NOT NULL DEFAULT 'user',
      plan          TEXT        NOT NULL DEFAULT 'basic',
      active        BOOLEAN     NOT NULL DEFAULT true,
      approved      BOOLEAN     NOT NULL DEFAULT false,
      sections      JSONB       NOT NULL DEFAULT '["pipeline","topics","wizard","config"]'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS topics (
      id          INTEGER     NOT NULL,
      user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic       TEXT        NOT NULL,
      pilastro    TEXT        NOT NULL DEFAULT 'educativo',
      photo_id    TEXT        NOT NULL DEFAULT '',
      parlato     TEXT        NOT NULL DEFAULT '',
      note        TEXT        NOT NULL DEFAULT '',
      status      TEXT        NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS user_config (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config  JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  console.info('[DB] ✅ Schema PostgreSQL inizializzato');
}

// ─── Users ────────────────────────────────────────────────────────────────────

function rowToUser(r) {
  return {
    id:           r.id,
    email:        r.email,
    name:         r.name,
    passwordHash: r.password_hash,
    role:         r.role,
    plan:         r.plan,
    active:       r.active,
    approved:     r.approved,
    sections:     Array.isArray(r.sections)
                    ? r.sections
                    : JSON.parse(r.sections || '["pipeline","topics","wizard","config"]'),
    createdAt:    r.created_at instanceof Date
                    ? r.created_at.toISOString()
                    : String(r.created_at),
  };
}

export async function dbReadUsers() {
  const { rows } = await pool().query('SELECT * FROM users ORDER BY created_at ASC');
  return rows.map(rowToUser);
}

export async function dbUpsertUser(user) {
  await pool().query(`
    INSERT INTO users (id, email, name, password_hash, role, plan, active, approved, sections, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    ON CONFLICT (id) DO UPDATE SET
      email         = EXCLUDED.email,
      name          = EXCLUDED.name,
      password_hash = EXCLUDED.password_hash,
      role          = EXCLUDED.role,
      plan          = EXCLUDED.plan,
      active        = EXCLUDED.active,
      approved      = EXCLUDED.approved,
      sections      = EXCLUDED.sections
  `, [
    user.id,
    user.email,
    user.name || '',
    user.passwordHash,
    user.role     || 'user',
    user.plan     || 'basic',
    user.active   !== false,
    user.approved !== false,
    JSON.stringify(user.sections || ['pipeline','topics','wizard','config']),
    user.createdAt || new Date().toISOString(),
  ]);
}

export async function dbDeleteUser(userId) {
  await pool().query('DELETE FROM users WHERE id = $1', [userId]);
}

// ─── Topics ───────────────────────────────────────────────────────────────────

function rowToTopic(r) {
  return {
    id:       r.id,
    topic:    r.topic,
    pilastro: r.pilastro,
    photoId:  r.photo_id,
    parlato:  r.parlato,
    note:     r.note,
    status:   r.status,
  };
}

export async function dbReadUserTopics(userId) {
  const { rows } = await pool().query(
    'SELECT * FROM topics WHERE user_id = $1 ORDER BY id ASC',
    [userId]
  );
  return rows.map(rowToTopic);
}

export async function dbWriteUserTopics(userId, topics) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM topics WHERE user_id = $1', [userId]);
    for (const t of topics) {
      await client.query(`
        INSERT INTO topics (id, user_id, topic, pilastro, photo_id, parlato, note, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        t.id, userId,
        t.topic,
        t.pilastro || 'educativo',
        t.photoId  || '',
        t.parlato  || '',
        t.note     || '',
        t.status   || 'pending',
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── User Config ──────────────────────────────────────────────────────────────

export async function dbReadUserConfig(userId) {
  const { rows } = await pool().query(
    'SELECT config FROM user_config WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.config || {};
}

export async function dbMergeUserConfig(userId, vars) {
  await pool().query(`
    INSERT INTO user_config (user_id, config)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (user_id) DO UPDATE
      SET config = user_config.config || EXCLUDED.config
  `, [userId, JSON.stringify(vars)]);
}

// ─── Migrazione one-time: JSON → DB ──────────────────────────────────────────

export async function migrateFromFiles(usersFile, usersDir) {
  const { rows } = await pool().query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) > 0) return; // già migrato

  console.info('[DB] Prima migrazione: importo dati da file JSON...');

  // Utenti
  if (fs.existsSync(usersFile)) {
    try {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      for (const u of users) await dbUpsertUser(u);
      console.info(`[DB] Migrati ${users.length} utenti`);
    } catch (e) {
      console.warn(`[DB] Migrazione utenti fallita: ${e.message}`);
    }
  }

  // Topics + Config per ogni utente
  if (fs.existsSync(usersDir)) {
    const dirs = fs.readdirSync(usersDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const uid of dirs) {
      const topicsFile = path.join(usersDir, uid, 'topics.json');
      const configFile = path.join(usersDir, uid, 'config.json');

      if (fs.existsSync(topicsFile)) {
        try {
          const topics = JSON.parse(fs.readFileSync(topicsFile, 'utf8'));
          await dbWriteUserTopics(uid, topics);
          console.info(`[DB] Migrati ${topics.length} topics per utente ${uid}`);
        } catch (e) {
          console.warn(`[DB] Topics migrazione fallita per ${uid}: ${e.message}`);
        }
      }

      if (fs.existsSync(configFile)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
          await dbMergeUserConfig(uid, cfg);
          console.info(`[DB] Config migrata per utente ${uid}`);
        } catch (e) {
          console.warn(`[DB] Config migrazione fallita per ${uid}: ${e.message}`);
        }
      }
    }
  }

  console.info('[DB] ✅ Migrazione da file JSON completata');
}
