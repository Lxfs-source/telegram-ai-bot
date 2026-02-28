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
    voices_date TEXT DEFAULT '',

    lang TEXT DEFAULT '',
    response_len TEXT DEFAULT 'normal',
    premium_tier TEXT DEFAULT 'none',
    credits_month TEXT DEFAULT '',
    credits_monthly INTEGER DEFAULT 0,
    credits_purchased INTEGER DEFAULT 0
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

// --- payments (idempotency for Telegram successful_payment) ---
db.prepare(`
CREATE TABLE IF NOT EXISTS payments (
  telegram_charge_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  invoice_payload TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at)`).run();

// --- settings (simple key-value store) ---
db.prepare(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
`).run();

// --- video cache (prompt hash -> Telegram file_id) ---
db.prepare(`
CREATE TABLE IF NOT EXISTS video_cache (
  hash TEXT PRIMARY KEY,
  seconds INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
`).run();



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

// --- миграция: локализация и длина ответов + кредиты для видео ---
const userCols2 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols2.includes("lang")) {
  db.prepare("ALTER TABLE users ADD COLUMN lang TEXT DEFAULT ''").run();
}
if (!userCols2.includes("response_len")) {
  db.prepare("ALTER TABLE users ADD COLUMN response_len TEXT DEFAULT 'normal'").run();
}
if (!userCols2.includes("premium_tier")) {
  db.prepare("ALTER TABLE users ADD COLUMN premium_tier TEXT DEFAULT 'none'").run();
}
if (!userCols2.includes("credits_month")) {
  db.prepare("ALTER TABLE users ADD COLUMN credits_month TEXT DEFAULT ''").run();
}
if (!userCols2.includes("credits_monthly")) {
  db.prepare("ALTER TABLE users ADD COLUMN credits_monthly INTEGER DEFAULT 0").run();
}
if (!userCols2.includes("credits_purchased")) {
  db.prepare("ALTER TABLE users ADD COLUMN credits_purchased INTEGER DEFAULT 0").run();
}

// migration safety: ensure payments table exists in older dbs
// (CREATE TABLE IF NOT EXISTS already covers it)
// ---------------- helpers ----------------

function getSetting(key, defaultValue = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return defaultValue;
  return row.value;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function incrSetting(key, delta = 1) {
  const cur = parseInt(getSetting(key, "0"), 10) || 0;
  const next = cur + (delta || 0);
  setSetting(key, String(next));
  return next;
}

function getCachedVideo(hash) {
  return db.prepare("SELECT * FROM video_cache WHERE hash = ?").get(hash);
}

function setCachedVideo({ hash, seconds, prompt, telegram_file_id }) {
  if (!hash || !telegram_file_id) return;
  db.prepare(`
    INSERT INTO video_cache (hash, seconds, prompt, telegram_file_id, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      seconds = excluded.seconds,
      prompt = excluded.prompt,
      telegram_file_id = excluded.telegram_file_id,
      created_at = excluded.created_at
  `).run(hash, seconds || 4, String(prompt || ""), String(telegram_file_id || ""), Date.now());
}


function dayKey(d = new Date()) {
    // YYYY-MM-DD
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
}

function monthKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
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
    // New user: give a small one-time signup video credit (safe by global limit)
    const SIGNUP_CREDITS = parseInt(process.env.SIGNUP_VIDEO_CREDITS || "1", 10);
    const GLOBAL_LIMIT = parseInt(process.env.SIGNUP_VIDEO_CREDITS_GLOBAL_LIMIT || "50", 10); // 0 = unlimited
    let give = Math.max(0, SIGNUP_CREDITS);

    if (GLOBAL_LIMIT > 0) {
      const used = parseInt(getSetting("signup_video_credits_used", "0"), 10) || 0;
      if (used >= GLOBAL_LIMIT) give = 0;
    }

    db.prepare(`
      INSERT INTO users (
        user_id,
        is_premium,
        premium_until,
        response_mode,
        personality,
        custom_personality,
        voice_key,
        premium_tier,
        credits_purchased
      )
      VALUES (?, 0, 0, 'text', 'default', '', 'alloy', 'none', ?)
    `).run(userId, give);

    if (give > 0) {
      incrSetting("signup_video_credits_used", 1);
    }

    user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  }


  // на всякий случай (если старый юзер без значения):
  if (!user.voice_key) user.voice_key = "alloy";

  // ежемесячные кредиты (free/premium) + не трогаем купленные
  ensureMonthlyCredits(user.user_id);
  user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);

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


function setLang(userId, lang) {
  db.prepare(`UPDATE users SET lang = ? WHERE user_id = ?`).run(lang, userId);
}

function setResponseLen(userId, responseLen) {
  db.prepare(`UPDATE users SET response_len = ? WHERE user_id = ?`).run(responseLen, userId);
}

function setPremiumTier(userId, tier) {
  db.prepare(`UPDATE users SET premium_tier = ? WHERE user_id = ?`).run(tier, userId);
}

function ensureMonthlyCredits(userId) {
  const user = db.prepare("SELECT user_id, is_premium, premium_until, premium_tier, credits_month FROM users WHERE user_id = ?").get(userId);
  if (!user) return;

  const mk = monthKey();
  if ((user.credits_month || "") === mk) return;

  // reset monthly bucket each month; purchased bucket stays
  const premiumActive = isPremium({ user_id: userId, is_premium: user.is_premium, premium_until: user.premium_until });
  const tier = (user.premium_tier || "none").toLowerCase();

  const baseMonthly =
    premiumActive && tier === "proplus" ? 30 :
    premiumActive && tier === "pro" ? 12 :
    premiumActive ? 12 : // fallback
    1; // free marketing credit per month

  db.prepare(`
    UPDATE users
    SET credits_month = ?, credits_monthly = ?
    WHERE user_id = ?
  `).run(mk, baseMonthly, userId);
}

function getCredits(userId) {
  ensureMonthlyCredits(userId);
  const row = db.prepare(`SELECT credits_monthly, credits_purchased FROM users WHERE user_id = ?`).get(userId) || {};
  const monthly = row.credits_monthly || 0;
  const purchased = row.credits_purchased || 0;
  return { monthly, purchased, total: monthly + purchased };
}

// consume N video credits (monthly first, then purchased)
function consumeVideoCredits(userId, n = 1) {
  ensureMonthlyCredits(userId);
  const row = db.prepare(`SELECT credits_monthly, credits_purchased FROM users WHERE user_id = ?`).get(userId);
  const monthly = row?.credits_monthly || 0;
  const purchased = row?.credits_purchased || 0;
  const total = monthly + purchased;

  if (total < n) return { ok: false, usedMonthly: 0, usedPurchased: 0, left: total };

  let need = n;
  let usedMonthly = Math.min(monthly, need);
  need -= usedMonthly;

  let usedPurchased = 0;
  if (need > 0) {
    usedPurchased = need;
  }

  db.prepare(`
    UPDATE users
    SET credits_monthly = credits_monthly - ?,
        credits_purchased = credits_purchased - ?
    WHERE user_id = ?
  `).run(usedMonthly, usedPurchased, userId);

  const after = getCredits(userId);
  return { ok: true, usedMonthly, usedPurchased, left: after.total };
}

function refundVideoCredits(userId, usedMonthly = 0, usedPurchased = 0) {
  if ((usedMonthly || 0) <= 0 && (usedPurchased || 0) <= 0) return;
  db.prepare(`
    UPDATE users
    SET credits_monthly = credits_monthly + ?,
        credits_purchased = credits_purchased + ?
    WHERE user_id = ?
  `).run(usedMonthly || 0, usedPurchased || 0, userId);
}

function addPurchasedCredits(userId, amount) {
  db.prepare(`
    UPDATE users
    SET credits_purchased = COALESCE(credits_purchased,0) + ?
    WHERE user_id = ?
  `).run(amount, userId);
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

// ---------------- payments idempotency ----------------
function isPaymentProcessed(telegramChargeId) {
  if (!telegramChargeId) return false;
  const row = db
    .prepare("SELECT telegram_charge_id FROM payments WHERE telegram_charge_id = ?")
    .get(String(telegramChargeId));
  return !!row;
}

function recordPayment({ telegramChargeId, userId, invoicePayload, totalAmount, currency }) {
  if (!telegramChargeId) return;
  db.prepare(
    `INSERT OR IGNORE INTO payments(telegram_charge_id, user_id, invoice_payload, total_amount, currency, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`
  ).run(String(telegramChargeId), userId, String(invoicePayload || ""), totalAmount || 0, String(currency || ""), Date.now());
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
    // credits + i18n
    setLang,
    setResponseLen,
    setPremiumTier,
    getCredits,
    consumeVideoCredits,
    refundVideoCredits,
    addPurchasedCredits,

    // payments
    isPaymentProcessed,
    recordPayment,

    // settings + cache
    getSetting,
    setSetting,
    incrSetting,
    getCachedVideo,
    setCachedVideo,

};