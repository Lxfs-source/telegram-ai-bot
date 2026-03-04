const Database = require("better-sqlite3");

const db = new Database("bot.db");

// --- users ---
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    is_premium INTEGER DEFAULT 0,
    premium_until INTEGER DEFAULT 0,
    personality TEXT DEFAULT 'default',
    custom_personality TEXT DEFAULT '',
    response_mode TEXT DEFAULT 'text',
    voice_key TEXT DEFAULT 'alloy',
    images_today INTEGER DEFAULT 0,
    images_date TEXT DEFAULT '',

    videos_today INTEGER DEFAULT 0,
    videos_date TEXT DEFAULT '',

    voices_week INTEGER DEFAULT 0,
    voices_date TEXT DEFAULT ''
)
`).run();

// --- messages memory ---
db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,       -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
)
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at)`).run();

// --- миграция: добавляем voice_key если её нет ---
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("voice_key")) {
  db.prepare("ALTER TABLE users ADD COLUMN voice_key TEXT DEFAULT 'alloy'").run();
}

// --- миграция: добавляем видео-лимиты если их нет ---
if (!userCols.includes("videos_today")) {
  db.prepare("ALTER TABLE users ADD COLUMN videos_today INTEGER DEFAULT 0").run();
}
if (!userCols.includes("videos_date")) {
  db.prepare("ALTER TABLE users ADD COLUMN videos_date TEXT DEFAULT ''").run();
}
// ---------------- helpers ----------------
function dayKey(d = new Date()) {
    // YYYY-MM-DD
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
}

function isoWeekKey(d = new Date()) {
    // ISO week key: YYYY-Www
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ---------------- users ----------------
function getUser(userId) {
  let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);

  if (!user) {
    // Авто-премиум (trial) для новых пользователей на 10 дней
    const trialUntil = Date.now() + 10 * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO users (user_id, is_premium, premium_until, response_mode, personality, custom_personality, voice_key)
      VALUES (?, 1, ?, 'text', 'default', '', 'alloy')
    `).run(userId, trialUntil);

    user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  }

  // на всякий случай (если старый юзер без значения):
  if (!user.voice_key) user.voice_key = "alloy";

  return user;
}


function setResponseMode(userId, mode) {
    db.prepare(`UPDATE users SET response_mode = ? WHERE user_id = ?`).run(mode, userId);
}

function clearMemory(userId) {
    db.prepare(`DELETE FROM messages WHERE user_id = ?`).run(userId);
}

function setPersonality(userId, personality) {
    db.prepare(`
        UPDATE users
        SET personality = ?, custom_personality = ''
        WHERE user_id = ?
    `).run(personality, userId);

    clearMemory(userId);
}
function setVoiceKey(userId, voiceKey) {
  db.prepare(`UPDATE users SET voice_key = ? WHERE user_id = ?`).run(voiceKey, userId);
}

function setCustomPersonality(userId, personality) {
    db.prepare(`UPDATE users SET custom_personality = ? WHERE user_id = ?`).run(personality, userId);
    clearMemory(userId); // важное: чистим память при смене кастомной личности
}

function setPremium(userId, days) {
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE users SET is_premium = 1, premium_until = ? WHERE user_id = ?`).run(until, userId);
}

function isPremium(user) {
    if (!user.is_premium) return false;

    if (Date.now() > user.premium_until) {
        db.prepare(`UPDATE users SET is_premium = 0 WHERE user_id = ?`).run(user.user_id);
        return false;
    }
    return true;
}

function setUserVoice(userId, voiceKey) {
  // alias for backwards compatibility
  setVoiceKey(userId, voiceKey);
}

function getUserVoice(userId) {
  const row = db.prepare(`SELECT voice_key FROM users WHERE user_id = ?`).get(userId);
  return row?.voice_key || "alloy";
}

// ---------------- memory ----------------
function addMessage(userId, role, content, limit = 20) {
    db.prepare(`
        INSERT INTO messages (user_id, role, content, created_at)
        VALUES (?, ?, ?, ?)
    `).run(userId, role, content, Date.now());

    // оставляем только последние limit сообщений
    db.prepare(`
        DELETE FROM messages
        WHERE user_id = ?
        AND id NOT IN (
            SELECT id FROM messages
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ?
        )
    `).run(userId, userId, limit);
}

function getLastMessages(userId, limit = 20) {
    return db.prepare(`
        SELECT role, content
        FROM messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(userId, limit).reverse();
}

// ---------------- limits ----------------
// картинки: free 1/day, premium 20/day
function consumeImage(userId, premium) {
    const user = getUser(userId);
    const today = dayKey();

    const max = premium ? 20 : 1;

    if (user.images_date !== today) {
        db.prepare(`UPDATE users SET images_date = ?, images_today = 0 WHERE user_id = ?`).run(today, userId);
    }

    const fresh = getUser(userId);
    if (fresh.images_today >= max) return { ok: false, left: 0, max };

    db.prepare(`UPDATE users SET images_today = images_today + 1 WHERE user_id = ?`).run(userId);

    const after = getUser(userId);
    return { ok: true, left: Math.max(0, max - after.images_today), max };
}

// голосовые ответы: free 7/week, premium 100/week
function consumeVoice(userId, premium) {
    const user = getUser(userId);
    const wk = isoWeekKey();

    const max = premium ? 100 : 7;

    if (user.voices_date !== wk) {
        db.prepare(`UPDATE users SET voices_date = ?, voices_week = 0 WHERE user_id = ?`).run(wk, userId);
    }

    const fresh = getUser(userId);
    if (fresh.voices_week >= max) return { ok: false, left: 0, max };

    db.prepare(`UPDATE users SET voices_week = voices_week + 1 WHERE user_id = ?`).run(userId);

    const after = getUser(userId);
    return { ok: true, left: Math.max(0, max - after.voices_week), max };
}

// видео: free 1/day (4s), premium 10/day (12s)
function consumeVideo(userId, premium) {
  const user = getUser(userId);
  const today = dayKey();

  const max = premium ? 10 : 1;

  if (user.videos_date !== today) {
    db.prepare(`UPDATE users SET videos_date = ?, videos_today = 0 WHERE user_id = ?`).run(today, userId);
  }

  const fresh = getUser(userId);
  if ((fresh.videos_today || 0) >= max) return { ok: false, left: 0, max };

  db.prepare(`UPDATE users SET videos_today = COALESCE(videos_today, 0) + 1 WHERE user_id = ?`).run(userId);

  const after = getUser(userId);
  const used = after.videos_today || 0;
  return { ok: true, left: Math.max(0, max - used), max };
}

module.exports = {
    getUser,
    setResponseMode,
    setPersonality,
    setCustomPersonality,
    setPremium,
    isPremium,

    // voice
    setVoiceKey,
    setUserVoice,
    getUserVoice,

    addMessage,
    getLastMessages,
    clearMemory,
    consumeImage,
    consumeVoice,
    consumeVideo,
};