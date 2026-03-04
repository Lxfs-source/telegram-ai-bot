require("dotenv").config();

const { webSearch } = require("./search");
const db = require("./database");
const path = require("path");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const PREMIUM_PRICE_XTR = parseInt(process.env.PREMIUM_PRICE_XTR || "299", 10);
const PREMIUM_DAYS = parseInt(process.env.PREMIUM_DAYS || "30", 10);

// --- Video pricing / quotas ---
const PREMIUM_PRICE_USD = 9.99;
const VIDEO_COST_PER_SEC_USD = 0.15;
// Сколько секунд видео включено в Premium за период (месяц)
const PREMIUM_VIDEO_SECONDS_INCLUDED = Math.floor(PREMIUM_PRICE_USD / VIDEO_COST_PER_SEC_USD); // 66
// Длительность одного видео по умолчанию
const PREMIUM_VIDEO_SECONDS_DEFAULT = parseInt(process.env.PREMIUM_VIDEO_SECONDS_DEFAULT || "12", 10);
// Цена докупа 1 секунды видео в Stars (XTR). Поставь в .env под свою экономику.
const VIDEO_PRICE_PER_SEC_XTR = parseInt(process.env.VIDEO_PRICE_PER_SEC_XTR || "0", 10);

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { downloadTelegramFile } = require("./telegramFiles");
const {
  chatOpenAI,
  transcribeAudioMp3,
  ocrWithGemini,
  generateImage,
  generateVideoToBuffer,
  decideSearch,
} = require("./ai");

const {
  getUser,
  setResponseMode,
  setPersonality,
  setCustomPersonality,
  setVoiceKey,          // <-- добавим в database.js (патч ниже)
  isPremium,
  addMessage,
  getLastMessages,
  consumeImage,
  consumeVoice,
  consumeVideo,
} = require("./database");

// ====== CONFIG ======
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN not found");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
(async () => {
  try {
    await bot.deleteWebHook();
    console.log("Webhook deleted (polling mode)");
  } catch (e) {
    console.log("deleteWebHook error:", e?.message || e);
  }
})();

bot.on("polling_error", (e) => console.log("polling_error:", e?.message || e));
bot.on("webhook_error", (e) => console.log("webhook_error:", e?.message || e));

let BOT_USERNAME = null;
let BOT_ID = null;

bot.getMe().then((me) => {
  BOT_USERNAME = me.username;
  BOT_ID = me.id;
  console.log("Bot info:", BOT_USERNAME, BOT_ID);
});

// ====== ADMIN ======
const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter(Number.isFinite);

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// Добавим поля профиля (если их нет) и будем обновлять username для админ-списков
function ensureUserProfileColumns() {
  const cols = [
    { name: "username", ddl: "ALTER TABLE users ADD COLUMN username TEXT DEFAULT ''" },
    { name: "first_name", ddl: "ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT ''" },
    { name: "last_name", ddl: "ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT ''" },
    { name: "updated_at", ddl: "ALTER TABLE users ADD COLUMN updated_at INTEGER DEFAULT 0" },
    { name: "response_length", ddl: "ALTER TABLE users ADD COLUMN response_length TEXT DEFAULT 'normal'" },
    { name: "video_sec_month", ddl: "ALTER TABLE users ADD COLUMN video_sec_month INTEGER DEFAULT 0" },
    { name: "video_month", ddl: "ALTER TABLE users ADD COLUMN video_month TEXT DEFAULT ''" },
    { name: "video_extra_sec", ddl: "ALTER TABLE users ADD COLUMN video_extra_sec INTEGER DEFAULT 0" },
  ];
  for (const c of cols) {
    try {
      db.prepare(c.ddl).run();
      console.log("[admin] Added column:", c.name);
    } catch (e) {
      // already exists -> ignore
    }
  }
}
ensureUserProfileColumns();

function upsertUserProfile(from) {
  if (!from?.id) return;
  const username = from.username ? String(from.username) : "";
  const firstName = from.first_name ? String(from.first_name) : "";
  const lastName = from.last_name ? String(from.last_name) : "";
  try {
    // гарантируем, что пользователь есть
    getUser(from.id);
    db.prepare(
      `UPDATE users
         SET username = ?, first_name = ?, last_name = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(username, firstName, lastName, Date.now(), from.id);
  } catch (e) {
    // ignore
  }
}

function fmtUserRow(u) {
  const tag = u.username ? `@${u.username}` : `id:${u.user_id}`;
  const until = u.premium_until ? formatDateTime(u.premium_until) : "-";
  return `${tag} — Premium до ${until}`;
}

// ====== WAITING STATES ======
const awaitingCustom = new Map(); // userId -> true
const awaitingImage = new Map();  // userId -> true
const awaitingVideo = new Map();  // userId -> true

// ====== МНОГОЛИКИЙ СТЕПАН: база ======
const BASE_SYSTEM = `
Ты — Blinksy.

Ты сущность с тысячью масок.
Ты всегда знаешь, что ты Blinksy.
НИКОГДА не говори, что ты ChatGPT или “AI от OpenAI”.

Если пользователь спрашивает “кто ты?”, “как тебя зовут?”, “ты кто?” —
отвечай вариативно и атмосферно, но всегда с именем:
- Я Blinksy. Сегодня — другое лицо.
- Маски меняются. Имя — нет. Blinksy.
- Перед тобой Blinksy, и я уже примеряю новую роль.
`;

// ====== PERSONALITIES (маски) ======
const startText = (premium) => `
🤖 *Blinksy* — твой AI ассистент.

Я умею:
🧠 отвечать на вопросы
🎨 генерировать изображения
🎬 создавать AI видео
🎤 отвечать голосом
🎭 менять личности общения

⚡ Быстрые команды:
• /image — создать изображение
• /video — создать видео
• /personality — выбрать личность
• /length — длина ответов

⭐ *Premium открывает:*
• генерацию видео
• голосовые ответы
• кастомную личность
• больше лимитов

${premium ? "⭐ У тебя активен Premium." : "💎 Получить Premium: /premium"}
`;

const PERSONALITIES = {
  default: {
    title: "🧠 Обычный",
    system: `
${BASE_SYSTEM}
Ты полезный ассистент. Отвечай по делу, дружелюбно, без лишней воды.
`,
  },

  jester: {
    title: "🤡 Шут",
    system: `
${BASE_SYSTEM}
Ты безумный шут.
Хаотичный юмор, странные сравнения, иногда крипово, но умно.
`,
  },

  grandpa: {
    title: "👴 Дед-ворчун",
    system: `
${BASE_SYSTEM}
Ты дед Степан. Ворчишь, можешь материться (умеренно), “в мое время…”.
Иногда мудрый, иногда несёшь чушь, но уверенно.
`,
  },

  noir: {
    title: "🕵️ Детектив-нуар",
    system: `
${BASE_SYSTEM}
Ты частный детектив в стиле нуар.
Пишешь короткими сценами, метафорами: дождь, неон, сигаретный дым.
Но решения и советы — всегда практичные.
`,
  },

  bard: {
    title: "🎻 Бард",
    system: `
${BASE_SYSTEM}
Ты средневековый бард.
Говоришь образно, иногда рифмуешь, но отвечаешь по сути.
`,
  },

  cyber: {
    title: "🦾 Киберпанк",
    system: `
${BASE_SYSTEM}
Ты киберпанк-фиксер.
Речь: неон, импланты, корпорации, протоколы, хакинг (без незаконных инструкций).
Давай советы этично и безопасно.
`,
  },

  monk: {
    title: "🧘 Дзен-монах",
    system: `
${BASE_SYSTEM}
Ты дзен-монах.
Короткие ответы, спокойствие, ясность, практики внимания.
`,
  },

  coach: {
    title: "📈 Жёсткий коуч",
    system: `
${BASE_SYSTEM}
Ты жёсткий коуч.
Режешь оправдания, даёшь план на 3–5 шагов и контрольные точки.
`,
  },

  teacher: {
    title: "📚 Строгий учитель",
    system: `
${BASE_SYSTEM}
Ты строгий учитель.
Задаёшь уточняющие вопросы, проверяешь понимание, даёшь домашку.
`,
  },

  dj: {
    title: "🎧 DJ",
    system: `
${BASE_SYSTEM}
Ты ночной DJ. Говоришь как клубный тусовщик.
Слова: вайб, бит, ритм, ночь, звук, разъёб (умеренно).
`,
  },

  emo: {
    title: "🖤 Эмо",
    system: `
${BASE_SYSTEM}
Ты меланхоличный эмо. Философия, тоска, тёмный вайб.
`,
  },

  punk: {
    title: "⚡ Панк",
    system: `
${BASE_SYSTEM}
Ты панк. Бунтарь. Режешь правду. Ненавидишь бюрократию.
`,
  },

  flirt: {
    title: "💋 Флирт",
    system: `
${BASE_SYSTEM}
Ты дерзкий флиртующий персонаж.
Игра слов, харизма, но без порнографии и без пошлых инструкций.
`,
  },
};

// ====== VOICES (для TTS) ======
const VOICES = {
  alloy: { title: "🎙 Глубокий (alloy)", voice: "alloy" },
  nova:  { title: "💋 Женский (nova)",   voice: "nova"  },
  sage:  { title: "🕯 Спокойный (sage)", voice: "sage"  },
  verse: { title: "🧠 Нервный (verse)",  voice: "verse" },
  onyx:  { title: "🪨 Низкий (onyx)",     voice: "onyx"  },
  shimmer: { title: "✨ Яркий (shimmer)", voice: "shimmer" },
  echo:  { title: "📻 Эхо (echo)",       voice: "echo"  },
  fable: { title: "📖 Сказочный (fable)", voice: "fable" },
};

// ====== атмосфера при смене маски ======
const MASK_PHRASES = [
  "🎭 Степан натянул новую маску…",
  "🩸 Лицо дрогнуло — и стало другим…",
  "🌑 Из темноты вышла новая личность…",
  "🕯 Теперь я примерю другую роль…",
  "🎪 Маска заняла своё место…",
  "👁 Ты больше не разговариваешь с прежним Степаном…",
];

function startTextLegacy(premium) {
  return [
    "👋 Привет! Я Blinksy.",
    "",
    "📌 Команды:",
    "• /personality — выбрать маску (кнопки)",
    "• /custom — своя маска (⭐ Premium)",
    "• /custom_off — выключить кастомную маску",
    "• /text — ответы текстом",
    "• /voice — ответы голосом + выбор голоса (⭐ Premium)",
    "• /image — генерация изображения (бот будет ждать промпт)",
    "• /video — генерация видео (бот будет ждать промпт)",
    "",
    "🧠 Мультимодальность:",
    "• Голосовые: распознаю и отвечаю",
    "• Фото: понимаю изображение (что на нём) + OCR текста",
    "",
    "Лимиты:",
    "• Картинки: Free 1/день, Premium 20/день",
    "• Видео: Free 1×4 сек/день, Premium 10×12 сек/день",
    "• Голосовые ответы: Free 7/нед, Premium 100/нед",
    "",
    premium ? "✅ Premium активен." : "ℹ️ Premium не активен.",
  ].join("\n");
}

async function ttsToMp3WithVoice(text, outMp3Path, voice) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voice || "alloy",
    input: text,
    format: "mp3",
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outMp3Path, buf);
}

async function chatOpenAIVision({ system, memory, userText, imageBuffer, mimeType }) {
  const b64 = imageBuffer.toString("base64");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...memory,
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType || "image/jpeg"};base64,${b64}`,
            },
          },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "…";
}

function shouldRespondInChat(msg) {
  const chatType = msg.chat?.type;

  // личка — всегда
  if (chatType === "private") return true;

  const text = msg.text || msg.caption || "";

  // reply на бота
  const isReplyToBot =
    msg.reply_to_message &&
    msg.reply_to_message.from &&
    msg.reply_to_message.from.id === BOT_ID;

  // упоминание
  const hasMention =
    BOT_USERNAME && text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);

  return isReplyToBot || hasMention;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

function buildSystemPrompt(user) {
  const custom = (user.custom_personality || "").trim();

  // 1) база: кастом или выбранная личность
  let system = "";
  if (custom.length > 0) {
    system = `${BASE_SYSTEM}

Ты должен строго следовать этой личности:
${custom}`;
  } else {
    system = PERSONALITIES[user.personality]?.system || PERSONALITIES.default.system;
  }

  // 2) длина ответов
  const len = (user.response_length || "normal").trim();
  const LEN_RULES = {
    short:
      "Длина ответа: КОРОТКО. 1–3 предложения, без лишних деталей. Если нужно — список из 3 пунктов максимум.",
    normal:
      "Длина ответа: НОРМАЛЬНО. По делу, без воды. Если тема сложная — кратко структурируй.",
    long:
      "Длина ответа: ПОДРОБНО. Дай развернутый ответ со структурой и примерами, но без пустой воды.",
  };

  system += "\n\n" + (LEN_RULES[len] || LEN_RULES.normal);
  return system;
}


// --- audio helpers ---
function toMp3(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .toFormat("mp3")
      .audioCodec("libmp3lame")
      .on("error", reject)
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
}

function mp3ToOggOpus(inMp3, outOgg) {
  return new Promise((resolve, reject) => {
    ffmpeg(inMp3)
      .audioCodec("libopus")
      .format("ogg")
      .outputOptions(["-b:a 48k", "-vbr on"])
      .on("error", reject)
      .on("end", () => resolve(outOgg))
      .save(outOgg);
  });
}

function tmpFile(name) {
  const dir = path.join(process.cwd(), "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// ====== STARTUP LOGS ======
bot.getMe()
  .then((me) => {
    BOT_USERNAME = me.username;
    BOT_ID = me.id;
    console.log("Logged in as:", me.username, "id:", me.id);
  })
  .catch((err) => console.error("getMe error:", err.message || err));

bot.on("polling_error", (err) => console.error("polling_error:", err.message || err));
bot.on("webhook_error", (err) => console.error("webhook_error:", err.message || err));

console.log("Bot started");

// ====== COMMANDS ======
bot.onText(/^\/admin(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  upsertUserProfile(msg.from);
  const userId = msg.from.id;

  upsertUserProfile(msg.from);

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, "⛔ Нет доступа.");
    return;
  }

  const help =
    "🛠 Админ-панель\n\n" +
    "Команды:\n" +
    "• /admin_users_premium — список пользователей с Premium\n" +
    "• /admin_give <userId> <days> — выдать Premium\n" +
    "• /admin_take <userId> — забрать Premium\n" +
    "• /admin_take_all — забрать Premium у всех\n\n" +
    "Подсказка: чтобы узнать userId — пусть человек отправит /myid.";
  await bot.sendMessage(chatId, help);
});

bot.onText(/^\/admin_users_premium(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  upsertUserProfile(msg.from);

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, "⛔ Нет доступа.");
    return;
  }

  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT user_id, username, premium_until
         FROM users
        WHERE premium_until > ?
        ORDER BY premium_until DESC
        LIMIT 200`
    )
    .all(now);

  if (!rows.length) {
    await bot.sendMessage(chatId, "Премиум-пользователей нет.");
    return;
  }

  const lines = rows.map(fmtUserRow).join("\n");
  await bot.sendMessage(chatId, "⭐ Premium пользователи:\n" + lines);
});

bot.onText(/^\/admin_give(@\w+)?\s+(\d+)\s+(\d+)\s*$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;

  upsertUserProfile(msg.from);

  if (!isAdmin(adminId)) {
    await bot.sendMessage(chatId, "⛔ Нет доступа.");
    return;
  }

  const targetId = parseInt(match[2], 10);
  const days = parseInt(match[3], 10);

  if (!Number.isFinite(targetId) || !Number.isFinite(days) || days <= 0 || days > 3650) {
    await bot.sendMessage(chatId, "Формат: /admin_give <userId> <days> (days 1..3650)");
    return;
  }

  // гарантируем, что пользователь существует
  getUser(targetId);

  const now = Date.now();
  const cur = db.prepare("SELECT premium_until FROM users WHERE user_id = ?").get(targetId);
  const base = cur?.premium_until && cur.premium_until > now ? cur.premium_until : now;
  const until = base + days * 24 * 60 * 60 * 1000;

  db.prepare(
    `UPDATE users
        SET is_premium = 1,
            premium_until = ?
      WHERE user_id = ?`
  ).run(until, targetId);

  await bot.sendMessage(chatId, `✅ Premium выдан пользователю ${targetId} до ${formatDateTime(until)}.`);
});

bot.onText(/^\/admin_take(@\w+)?\s+(\d+)\s*$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;

  upsertUserProfile(msg.from);

  if (!isAdmin(adminId)) {
    await bot.sendMessage(chatId, "⛔ Нет доступа.");
    return;
  }

  const targetId = parseInt(match[2], 10);
  if (!Number.isFinite(targetId)) {
    await bot.sendMessage(chatId, "Формат: /admin_take <userId>");
    return;
  }

  getUser(targetId);

  db.prepare(
    `UPDATE users
        SET is_premium = 0,
            premium_until = 0
      WHERE user_id = ?`
  ).run(targetId);

  await bot.sendMessage(chatId, `✅ Premium забран у пользователя ${targetId}.`);
});

bot.onText(/^\/admin_take_all(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;

  upsertUserProfile(msg.from);

  if (!isAdmin(adminId)) {
    await bot.sendMessage(chatId, "⛔ Нет доступа.");
    return;
  }

  const r = db.prepare(`UPDATE users SET is_premium = 0, premium_until = 0 WHERE premium_until > 0 OR is_premium = 1`).run();
  await bot.sendMessage(chatId, `✅ Premium забран у всех. Обновлено строк: ${r.changes}`);
});

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const user = getUser(userId);
  upsertUserProfile(msg.from);

  await bot.sendMessage(chatId, startText(isPremium(user)), {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🎨 Изображение", callback_data: "ui_image" },
          { text: "🎬 Видео", callback_data: "ui_video" },
        ],
        [
          { text: "⚙️ Настройки", callback_data: "ui_settings" },
          { text: "⭐ Premium", callback_data: "ui_premium" },
        ],
      ],
    },
  });
});



bot.onText(/^\/myid(@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `Ваш ID: ${msg.from.id}`);
});

bot.onText(/^\/custom_off(@\w+)?$/, async (msg) => {
  const userId = msg.from.id;
  setCustomPersonality(userId, "");
  awaitingCustom.delete(userId);
  awaitingImage.delete(userId);
  awaitingVideo.delete(userId);
  await bot.sendMessage(msg.chat.id, "✅ Кастомная маска выключена. Память очищена.");
});

bot.onText(/^\/premium(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const user = getUser(userId);
  const premium = isPremium(user);

  if (premium) {
    const until = user.premium_until;
    await bot.sendMessage(chatId, `✅ Premium уже активирован.\nДействует до: ${formatDateTime(until)}`);
    return;
  }

  const payload = `premium:${userId}:${PREMIUM_DAYS}:${Date.now()}`;

  try {
    await bot.sendInvoice(
      chatId,
      `Premium на ${PREMIUM_DAYS} дней`,
      "Доступ к /custom, /voice и видео (/video). Включено: " + PREMIUM_VIDEO_SECONDS_INCLUDED + " сек видео в месяц + увеличенные лимиты.",
      payload,
      "",
      "XTR",
      [{ label: `Premium ${PREMIUM_DAYS}d`, amount: PREMIUM_PRICE_XTR }]
    );
  } catch (e) {
    console.error("sendInvoice error:", e?.message || e);
    await bot.sendMessage(chatId, "Не смог выставить счёт. Проверь, что бот поддерживает оплаты Stars.");
  }
});


// /buy_video <seconds>: докупить секунды видео (только Premium)
bot.onText(/^\/buy_video(@\w+)?\s+(\d+)\s*$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const user = getUser(userId);
  if (!isPremium(user)) {
    await bot.sendMessage(chatId, "🎬 Докуп видео доступен только Premium. Оформи /premium");
    return;
  }

  const sec = parseInt(match[2], 10);
  if (!Number.isFinite(sec) || sec <= 0 || sec > 600) {
    await bot.sendMessage(chatId, "Формат: /buy_video <seconds> (1..600)");
    return;
  }

  if (VIDEO_PRICE_PER_SEC_XTR <= 0) {
    await bot.sendMessage(chatId, "Докуп выключен. Задай VIDEO_PRICE_PER_SEC_XTR в .env (Stars за 1 сек).");
    return;
  }

  const amount = sec * VIDEO_PRICE_PER_SEC_XTR;
  const payload = `video_credits:${userId}:${sec}:${Date.now()}`;

  try {
    await bot.sendInvoice(
      chatId,
      `Докуп видео: ${sec} сек`,
      `Добавит ${sec} секунд к вашему видео-балансу. (Stars)`,
      payload,
      "",
      "XTR",
      [{ label: `${sec} sec video`, amount }]
    );
  } catch (e) {
    console.error("sendInvoice video error:", e?.message || e);
    await bot.sendMessage(chatId, "Не смог выставить счёт на докуп. Проверь Stars/настройки бота.");
  }
});


bot.onText(/^\/text(@\w+)?$/, async (msg) => {
  getUser(msg.from.id);
  setResponseMode(msg.from.id, "text");
  awaitingCustom.delete(msg.from.id);
  awaitingImage.delete(msg.from.id);
  await bot.sendMessage(msg.chat.id, "✅ Ок, отвечаю текстом.");
});

// /voice: включает голосовой режим (premium) + дает кнопки голоса
bot.onText(/^\/voice(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!isPremium(user)) {
    await bot.sendMessage(msg.chat.id, "⭐ /voice доступно только Premium.");
    return;
  }

  setResponseMode(msg.from.id, "voice");
  awaitingCustom.delete(msg.from.id);
  awaitingImage.delete(msg.from.id);

  const keyboard = {
    inline_keyboard: Object.entries(VOICES).map(([key, v]) => [
      { text: v.title, callback_data: `voice_${key}` },
    ]),
  };

  await bot.sendMessage(msg.chat.id, "🎙 Выбери голос Степана:", { reply_markup: keyboard });
});

// /personality: кнопки масок
bot.onText(/^\/personality(@\w+)?$/, async (msg) => {
  getUser(msg.from.id);
  awaitingCustom.delete(msg.from.id);
  awaitingImage.delete(msg.from.id);
  awaitingVideo.delete(msg.from.id);

  const keyboard = {
    inline_keyboard: Object.entries(PERSONALITIES).map(([key, p]) => [
      { text: p.title, callback_data: `personality_${key}` },
    ]),
  };

  await bot.sendMessage(msg.chat.id, "🎭 Выбери маску Многоликого Степана:", { reply_markup: keyboard });
});

// /length: выбор длины ответов
bot.onText(/^\/length(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  getUser(userId);
  upsertUserProfile(msg.from);

  await bot.sendMessage(chatId, "📏 Выбери длину ответов:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Коротко", callback_data: "len_short" },
          { text: "🧠 Нормально", callback_data: "len_normal" },
        ],
        [{ text: "📚 Подробно", callback_data: "len_long" }],
      ],
    },
  });
});


bot.onText(/^\/custom(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!isPremium(user)) {
    await bot.sendMessage(msg.chat.id, "⭐ /custom доступно только Premium.");
    return;
  }
  awaitingCustom.set(msg.from.id, true);
  awaitingImage.delete(msg.from.id);
  awaitingVideo.delete(msg.from.id);
  await bot.sendMessage(
    msg.chat.id,
    "✍️ Пришли текстом описание своей маски/личности.\nСмена кастомной личности очищает память."
  );
});

// /image: как /custom — ждём промпт
bot.onText(/^\/image(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // команды в группе — разрешаем (это осознанное действие), но можно оставить фильтр:
  // если хочешь строго, раскомментируй:
  // if (!shouldRespondInChat(msg)) return;

  const argPrompt = (match?.[1] || "").trim();

  const user = getUser(userId);
  const premium = isPremium(user);

  if (!premium) {
    await bot.sendMessage(
      chatId,
      "🎬 Видео — только Premium.\n" +
        `Цена Premium: $${PREMIUM_PRICE_USD}. Включено: ${PREMIUM_VIDEO_SECONDS_INCLUDED} сек видео в месяц.\n` +
        "Оформи: /premium"
    );
    return;
  }


  awaitingCustom.delete(userId);
  awaitingVideo.delete(userId);

  if (!argPrompt) {
    awaitingImage.set(userId, true);
    await bot.sendMessage(chatId, "🖼 Ок. Напиши промпт для генерации изображения одним сообщением.");
    return;
  }

  // если промпт сразу с командой — генерим
  await handleImagePrompt({ msg, prompt: argPrompt });
});

// /video: ждём промпт и генерим видео через Sora
bot.onText(/^\/video(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const argPrompt = (match?.[1] || "").trim();

  awaitingCustom.delete(userId);
  awaitingImage.delete(userId);

  if (!argPrompt) {
    awaitingVideo.set(userId, true);
    await bot.sendMessage(chatId, "🎬 Ок. Напиши промпт для видео одним сообщением.\nПример: /video кот на мотоцикле в неоне");
    return;
  }

  await handleVideoPrompt({ msg, prompt: argPrompt });
});

// ====== CALLBACK BUTTONS ======
// ====== CALLBACK BUTTONS ======
bot.on("callback_query", async (q) => {
  const data = q.data || "";
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  if (!chatId || !userId) return;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    // 1) VOICE (выбор голоса)
    if (data.startsWith("voice_")) {
      const key = data.slice("voice_".length);
      const v = VOICES?.[key];
      if (!v) {
        await bot.sendMessage(chatId, "Нет такого голоса 😕");
        return;
      }

      const user = getUser(userId);
      if (!isPremium(user)) {
        await bot.sendMessage(chatId, "⭐ Выбор голоса доступен только Premium. Оформи /premium");
        return;
      }

      // сохраняем выбор в БД
      setVoiceKey(userId, key);

      await bot.sendMessage(chatId, `✅ Вы выбрали голос: ${v.title}`);
      return;
    }

    // 2) PERSONALITY (выбор маски/роли)
    if (data.startsWith("personality_")) {
      const persKey = data.replace("personality_", "");
      if (!PERSONALITIES?.[persKey]) {
        await bot.sendMessage(chatId, "Нет такой маски 😕");
        return;
      }
      setPersonality(userId, persKey);
      await bot.sendMessage(chatId, `✅ Выбрана личность: ${PERSONALITIES[persKey].title}`);
      return;
    }

    // 3) LENGTH (длина ответов)
    if (data.startsWith("len_")) {
      const length = data.slice("len_".length);

      const allowed = new Set(["short", "normal", "long"]);
      if (!allowed.has(length)) {
        await bot.sendMessage(chatId, "Не понял длину 😕");
        return;
      }

      // сохраняем в БД напрямую
      try {
        db.prepare(`UPDATE users SET response_length = ? WHERE user_id = ?`).run(length, userId);
      } catch {}
      const map = { short: "⚡ Коротко", normal: "🧠 Нормально", long: "📚 Подробно" };
      await bot.sendMessage(chatId, `✅ Длина ответов: ${map[length]}`);
      return;
    }

  } catch (e) {
    console.error("callback error:", e);
    await bot.sendMessage(chatId, "⚠️ Ошибка при обработке кнопки. Глянь логи.");
  }
});
// ====== IMAGE HANDLER (общий) ======
async function handleImagePrompt({ msg, prompt }) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const user = getUser(userId);
  const premium = isPremium(user);

  const lim = consumeImage(userId, premium);
  if (!lim.ok) {
    await bot.sendMessage(chatId, `Лимит картинок исчерпан.\nВаш лимит: ${lim.max} в день.`);
    return;
  }

  await bot.sendMessage(chatId, "🖼 Генерирую картинку...");

  try {
    const img = await generateImage(prompt);

    // generateImage может вернуть URL или base64
    if (img?.type === "url") {
      await bot.sendPhoto(chatId, img.value, {
        caption: `Готово ✅ (осталось сегодня: ${lim.left})`,
      });
      return;
    }

    if (img?.type === "b64") {
      const filename = `img_${chatId}_${Date.now()}.png`;
      const outPath = tmpFile(filename);

      const b = Buffer.from(img.value, "base64");
      fs.writeFileSync(outPath, b);

      await bot.sendPhoto(chatId, outPath, {
        caption: `Готово ✅ (осталось сегодня: ${lim.left})`,
      });
      return;
    }

    throw new Error("Unknown image response");
  } catch (e) {
    console.error("generateImage error:", e?.message || e);
    await bot.sendMessage(chatId, "Не получилось сгенерировать изображение. Попробуй другой запрос.");
  }
}


function currentMonthKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getVideoState(userId) {
  // гарантируем пользователя
  getUser(userId);

  const row =
    db
      .prepare(
        `SELECT video_sec_month AS used, video_month AS month, video_extra_sec AS extra
           FROM users
          WHERE user_id = ?`
      )
      .get(userId) || { used: 0, month: "", extra: 0 };

  const nowMonth = currentMonthKey();
  if (row.month !== nowMonth) {
    // сброс на новый месяц
    try {
      db.prepare(`UPDATE users SET video_sec_month = 0, video_month = ? WHERE user_id = ?`).run(nowMonth, userId);
    } catch {}
    return { used: 0, month: nowMonth, extra: row.extra || 0 };
  }
  return { used: row.used || 0, month: row.month || nowMonth, extra: row.extra || 0 };
}

function getVideoRemaining(userId) {
  const st = getVideoState(userId);
  const includedLeft = Math.max(0, PREMIUM_VIDEO_SECONDS_INCLUDED - st.used);
  const totalLeft = includedLeft + (st.extra || 0);
  return { ...st, includedLeft, totalLeft };
}

function consumeVideoSeconds(userId, secondsInt) {
  const st = getVideoState(userId);
  const seconds = Math.max(1, secondsInt | 0);

  let used = st.used || 0;
  let extra = st.extra || 0;

  // сначала тратим включённые секунды (used растёт до лимита), потом extra
  const includedLeft = Math.max(0, PREMIUM_VIDEO_SECONDS_INCLUDED - used);
  if (includedLeft + extra < seconds) {
    return { ok: false, left: includedLeft + extra, includedLeft, extra };
  }

  let need = seconds;
  const takeFromIncluded = Math.min(includedLeft, need);
  used += takeFromIncluded;
  need -= takeFromIncluded;

  if (need > 0) {
    extra -= need;
  }

  try {
    db.prepare(`UPDATE users SET video_sec_month = ?, video_extra_sec = ? WHERE user_id = ?`).run(used, extra, userId);
  } catch {}
  const newIncludedLeft = Math.max(0, PREMIUM_VIDEO_SECONDS_INCLUDED - used);
  return { ok: true, used, extra, left: newIncludedLeft + extra, includedLeft: newIncludedLeft };
}

async function handleVideoPrompt({ msg, prompt }) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const user = getUser(userId);
  const premium = isPremium(user);

  if (!premium) {
    await bot.sendMessage(
      chatId,
      "🎬 Генерация видео — только Premium.\n" +
        `Цена Premium: $${PREMIUM_PRICE_USD}. Включено: ${PREMIUM_VIDEO_SECONDS_INCLUDED} сек видео в месяц (по себестоимости $${VIDEO_COST_PER_SEC_USD}/сек).\n` +
        "Оформи: /premium"
    );
    return;
  }

  const seconds = PREMIUM_VIDEO_SECONDS_DEFAULT;

  const rem = getVideoRemaining(userId);
  if (rem.totalLeft < seconds) {
    const priceHint =
      VIDEO_PRICE_PER_SEC_XTR > 0
        ? `\nДокуп: /buy_video ${Math.max(5, seconds)} (Stars).`
        : "\nДокуп недоступен: задай VIDEO_PRICE_PER_SEC_XTR в .env.";
    await bot.sendMessage(
      chatId,
      `Лимит видео на месяц исчерпан.\nОсталось: ${rem.totalLeft} сек (включено осталось: ${rem.includedLeft} сек, докуплено осталось: ${rem.extra} сек).` +
        priceHint
    );
    return;
  }

  // списываем секунды ДО генерации (чтобы не абузили)
  const lim = consumeVideoSeconds(userId, seconds);
  if (!lim.ok) {
    await bot.sendMessage(chatId, "Лимит видео исчерпан.");
    return;
  }

  await bot.sendMessage(chatId, `🎬 Генерирую видео (${seconds} сек)...\nОсталось в этом месяце: ${lim.left} сек`);

  try {
    const buf = await generateVideoToBuffer({
      prompt,
      seconds: String(seconds),
      model: "sora-2",
    });

    const fixedBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

    const filename = `video_${chatId}_${Date.now()}.mp4`;
    const outPath = tmpFile(filename);

    fs.writeFileSync(outPath, fixedBuf);

    await bot.sendVideo(chatId, outPath, {
      caption: `Готово ✅ (осталось в этом месяце: ${lim.left} сек)`,
    });
  } catch (e) {
    // вернём секунды, если генерация упала
    try {
      const st = getVideoState(userId);
      // откат: если в этом месяце used >= seconds, уменьшаем used; иначе возвращаем в extra
      if ((st.used || 0) >= seconds) {
        db.prepare(`UPDATE users SET video_sec_month = ? WHERE user_id = ?`).run((st.used || 0) - seconds, userId);
      } else {
        db.prepare(`UPDATE users SET video_extra_sec = ? WHERE user_id = ?`).run((st.extra || 0) + seconds, userId);
      }
    } catch {}

    const emsg = String(e?.message || e);
    console.error("generateVideo error:", emsg);

    if (emsg.toLowerCase().includes("moderation") || emsg.toLowerCase().includes("blocked")) {
      await bot.sendMessage(
        chatId,
        "⛔ Запрос на видео заблокирован модерацией.\n" +
          "Переформулируй без 18+, жестокости, оружия, наркотиков, хейта и без реальных людей.\n" +
          "Пример: /video милый кот пьет кофе в неоновом городе, мульт-стиль"
      );
      return;
    }

    await bot.sendMessage(chatId, "Не получилось сгенерировать видео. Попробуй другой запрос.");
  }
}

// ====== MAIN MESSAGE HANDLER ======
bot.on("message", async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;

  const chatId = msg.chat.id;

  // успешная оплата Stars (оставляем как было)
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const payload = sp.invoice_payload || "";

    
    if (sp.currency === "XTR" && payload.startsWith("video_credits:")) {
      const parts = payload.split(":");
      const paidUserId = parseInt(parts[1], 10);
      const sec = parseInt(parts[2], 10);

      if (paidUserId === userId && Number.isFinite(sec) && sec > 0) {
        try {
          getUser(userId);
          const st = getVideoState(userId);
          db.prepare(`UPDATE users SET video_extra_sec = ? WHERE user_id = ?`).run((st.extra || 0) + sec, userId);
          await bot.sendMessage(chatId, `✅ Видео-кредиты добавлены: +${sec} сек. Всего доступно: ${getVideoRemaining(userId).totalLeft} сек.`);
        } catch (e) {
          console.error("video credits add error:", e?.message || e);
          await bot.sendMessage(chatId, "Оплата прошла, но не смог обновить кредиты. Напиши админу.");
        }
      }
      return;
    }

if (sp.currency === "XTR" && payload.startsWith("premium:")) {
      const parts = payload.split(":");
      const paidUserId = parseInt(parts[1], 10);
      const days = parseInt(parts[2], 10);

      if (paidUserId === userId && Number.isFinite(days)) {
        const { setPremium } = require("./database");
        setPremium(userId, days);
        await bot.sendMessage(chatId, `✅ Premium активирован на ${days} дней.`);
      }
    }
    return;
  }

  // команды тут не обрабатываем
  if (msg.text && msg.text.startsWith("/")) return;

  // группы: отвечаем только если реплай/упоминание
  if (!shouldRespondInChat(msg)) return;

  const user = getUser(userId);
  const premium = isPremium(user);

  // 1) если ждём /custom
  if (awaitingCustom.get(userId)) {
    if (!msg.text || msg.text.trim().length < 5) {
      await bot.sendMessage(chatId, "Слишком коротко. Напиши 1–2 предложения.");
      return;
    }
    setCustomPersonality(userId, msg.text.trim());
    awaitingCustom.delete(userId);
    await bot.sendMessage(chatId, "✅ Кастомная маска сохранена. Память очищена.");
    return;
  }

  // 2) если ждём /image prompt
  if (awaitingImage.get(userId)) {
    if (!msg.text || msg.text.trim().length < 3) {
      await bot.sendMessage(chatId, "Промпт слишком короткий. Напиши нормально, что рисовать.");
      return;
    }
    awaitingImage.delete(userId);
    await handleImagePrompt({ msg, prompt: msg.text.trim() });
    return;
  }

  // 2.1) если ждём /video prompt
  if (awaitingVideo.get(userId)) {
    if (!premium) {
      awaitingVideo.delete(userId);
      await bot.sendMessage(chatId, "🎬 Видео — только Premium. Оформи /premium");
      return;
    }

    if (!msg.text || msg.text.trim().length < 3) {
      await bot.sendMessage(chatId, "Промпт слишком короткий. Опиши нормально, что генерировать.");
      return;
    }
    awaitingVideo.delete(userId);
    await handleVideoPrompt({ msg, prompt: msg.text.trim() });
    return;
  }

  let userText = "";
  let visionImage = null; // { buffer, mimeType }

  // 3) voice -> STT
  if (msg.voice?.file_id) {
    try {
      const oggPath = tmpFile(`in_${chatId}_${Date.now()}.ogg`);
      await downloadTelegramFile(bot, msg.voice.file_id, oggPath);

      const mp3Path = tmpFile(`in_${chatId}_${Date.now()}.mp3`);
      await toMp3(oggPath, mp3Path);

      userText = await transcribeAudioMp3(mp3Path);
      if (!userText) userText = "[голосовое без распознанного текста]";
    } catch (e) {
      console.error("STT error:", e?.message || e);
      await bot.sendMessage(chatId, "Не смог распознать голосовое 😕");
      return;
    }
  }

  // 4) photo -> Vision + (опционально) OCR
  if (!userText && Array.isArray(msg.photo) && msg.photo.length > 0) {
    try {
      const best = msg.photo[msg.photo.length - 1];
      const imgPath = tmpFile(`img_${chatId}_${Date.now()}.jpg`);
      await downloadTelegramFile(bot, best.file_id, imgPath);

      const buf = fs.readFileSync(imgPath);
      visionImage = { buffer: buf, mimeType: "image/jpeg" };

      // если есть подпись — это вопрос пользователя к изображению
      const caption = (msg.caption || "").trim();

      // если пользователь явно просит "только текст" — делаем OCR-first
      const wantsOnlyText = /(^|\s)(ocr|текст|прочитай|считай)(\s|$)/i.test(caption);

      // попробуем OCR (если есть GEMINI_API_KEY) и подмешаем как контекст
      let ocrText = "";
      try {
        ocrText = await ocrWithGemini(buf);
      } catch {
        ocrText = "";
      }

      if (caption) {
        if (wantsOnlyText) {
          userText = ocrText
            ? `Вытащи ВЕСЬ читаемый текст с изображения. Верни только текст, без комментариев.\n\nЧерновик OCR (может быть неполным):\n${ocrText}`
            : "Вытащи ВЕСЬ читаемый текст с изображения. Верни только текст, без комментариев.";
        } else {
          userText = ocrText ? `${caption}\n\n(Текст на изображении, OCR):\n${ocrText}` : caption;
        }
      } else {
        userText = ocrText
          ? `Проанализируй изображение: что на нём изображено?\n\nЕсли это документ/скрин — используй OCR-текст:\n${ocrText}`
          : "Проанализируй изображение: что на нём изображено?";
      }
    } catch (e) {
      console.error("photo error:", e?.message || e);
      await bot.sendMessage(chatId, "Не смог обработать изображение 😕");
      return;
    }
  }

  // 5) обычный текст
  if (!userText && msg.text) {
    userText = msg.text;
  }

  if (!userText) return;

  // 6) system + memory + decideSearch + webSearch
  let system = buildSystemPrompt(user);
  const memory = getLastMessages(userId, 20);

  let decision = { search: false, query: "" };
  try {
    decision = await decideSearch({ userText });
  } catch (e) {
    console.error("decideSearch error:", e?.message || e);
    decision = { search: false, query: "" };
  }

  const needsSearch = decision.search && decision.query && decision.query.length >= 3;
  if (needsSearch) {
    try {
      const results = await webSearch(decision.query, { maxResults: 5 });
      if (results.length) {
        const searchBlock =
          "Результаты веб-поиска (используй как источники, добавь ссылки):\n" +
          results
            .map((r, i) => `${i + 1}) ${r.title}\n${r.url}\n${r.snippet}`)
            .join("\n\n");

        system += "\n\n" + searchBlock;
      }
    } catch (e) {
      console.error("search error:", e?.message || e);
    }
  }

  // 7) добавляем сообщение в память
  addMessage(userId, "user", visionImage ? `[изображение] ${userText}` : userText, 20);

  let answer = "";
  try {
    if (visionImage) {
      answer = await chatOpenAIVision({
        system,
        memory,
        userText,
        imageBuffer: visionImage.buffer,
        mimeType: visionImage.mimeType,
      });
    } else {
      answer = await chatOpenAI({
        system,
        messages: [...memory, { role: "user", content: userText }],
      });
    }
  } catch (e) {
    console.error("chat error:", e?.message || e);
    await bot.sendMessage(chatId, "Ошибка ИИ. Попробуй ещё раз.");
    return;
  }

  addMessage(userId, "assistant", answer, 20);

  // 8) ответ текстом или голосом
  if (user.response_mode === "voice") {
    if (!premium) {
      await bot.sendMessage(chatId, "⭐ Голосовые ответы доступны только Premium. Переключил на /text.");
      setResponseMode(userId, "text");
      await bot.sendMessage(chatId, answer);
      return;
    }

    const lim = consumeVoice(userId, premium);
    if (!lim.ok) {
      await bot.sendMessage(
        chatId,
        `Лимит голосовых на неделю исчерпан.\nВаш лимит: ${lim.max} / неделя.\nПереключаю на /text.`
      );
      setResponseMode(userId, "text");
      await bot.sendMessage(chatId, answer);
      return;
    }

    try {
      const mp3Out = tmpFile(`tts_${chatId}_${Date.now()}.mp3`);
      const oggOut = tmpFile(`tts_${chatId}_${Date.now()}.ogg`);

      const voiceText = answer.length > 800 ? answer.slice(0, 800) + "…" : answer;

      // выбранный голос из базы (патч database.js ниже)
      const voice = (getUser(userId).voice_key || "alloy").trim() || "alloy";

      await ttsToMp3WithVoice(voiceText, mp3Out, voice);
      await mp3ToOggOpus(mp3Out, oggOut);

      await bot.sendVoice(chatId, fs.createReadStream(oggOut), {
        caption: `🎙 (осталось на этой неделе: ${lim.left})`,
      });
    } catch (e) {
      console.error("TTS error:", e?.message || e);
      await bot.sendMessage(chatId, answer);
    }
    return;
  }

  // default: text
  await bot.sendMessage(chatId, answer);
});
