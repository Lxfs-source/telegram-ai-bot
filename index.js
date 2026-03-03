require("dotenv").config();

const { webSearch } = require("./search");
const db = require("./database");
const path = require("path");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

const PREMIUM_PRICE_XTR = parseInt(process.env.PREMIUM_PRICE_XTR || "299", 10);
const PREMIUM_DAYS = parseInt(process.env.PREMIUM_DAYS || "30", 10);

const PRO_CREDITS_MONTHLY = parseInt(process.env.PRO_CREDITS_MONTHLY || "12", 10);
const PROPLUS_PRICE_XTR = parseInt(process.env.PROPLUS_PRICE_XTR || "599", 10);
const PROPLUS_CREDITS_MONTHLY = parseInt(process.env.PROPLUS_CREDITS_MONTHLY || "30", 10);
// 1️⃣ если fetch нет — добавь:
const fetch = global.fetch ? global.fetch : require("node-fetch");

// 2️⃣ конфиг D-ID
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_VOICE_PROVIDER = process.env.DID_VOICE_PROVIDER || "microsoft";
const DID_VOICE_ID = process.env.DID_VOICE_ID || "en-US-JennyNeural";

function didAuthHeader() {
  if (!DID_API_KEY) throw new Error("DID_API_KEY is not set");
  return `Basic ${Buffer.from(DID_API_KEY + ":").toString("base64")}`;
}

async function didUploadImage(imagePath) {
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";

  const boundary = "----blinksy_" + Math.random().toString(16).slice(2);
  const filename = path.basename(imagePath).slice(0, 50);

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(head, "utf8"),
    buf,
    Buffer.from(tail, "utf8"),
  ]);

  const res = await fetch("https://api.d-id.com/images", {
    method: "POST",
    headers: {
      Authorization: didAuthHeader(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`D-ID image upload failed: ${res.status} ${JSON.stringify(json)}`);
  }

  const url = json.url || json.source_url || json.image_url;
  if (!url) throw new Error("D-ID image upload: no url in response");

  return url;
}

const CREDIT_PACKS = [
  { id: "pack50", credits: 50, priceXTR: parseInt(process.env.CREDITS50_PRICE_XTR || "299", 10) },
  { id: "pack110", credits: 110, priceXTR: parseInt(process.env.CREDITS110_PRICE_XTR || "599", 10) },
  { id: "pack250", credits: 250, priceXTR: parseInt(process.env.CREDITS250_PRICE_XTR || "1199", 10) },
];

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

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
  setVoiceKey,
  isPremium,
  addMessage,
  getLastMessages,
  consumeImage,
  consumeVoice,
  // credits + settings
  setLang,
  setResponseLen,
  setPremiumTier,
  getCredits,
  consumeVideoCredits,
  refundVideoCredits,
  addPurchasedCredits,
  hasFreeDid,
  markFreeDidUsed,
  isPaymentProcessed,
  recordPayment,
  // cache
  getCachedVideo,
  setCachedVideo,
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


function detectLangFromTelegram(languageCode) {
  const lc = (languageCode || "").toLowerCase();
  const ruLike = ["ru","uk","be","kk","ky","uz","tg","az","hy","ka","mo"];
  return ruLike.some((p) => lc.startsWith(p)) ? "ru" : "en";
}

function looksCyrillicOrArmenian(text) {
  if (!text) return false;
  // Cyrillic: \u0400-\u04FF, Armenian: \u0530-\u058F
  return /[\u0400-\u04FF\u0530-\u058F]/.test(text);
}

const I18N = {
  ru: {
    balanceFull: (c) => `Кредиты: ${c.total} (купленные: ${c.purchased})`,
    noCredits: "Недостаточно кредитов. /buy",
    buyTitle: "Магазин",
    buyPick: "Выбери пакет:",
    buyDetails: (packsText) =>
`Пакеты кредитов (Stars):
${packsText}

Тарифы:
• D-ID (анимация фото, ~4с): 2 кредита
• Sora 2 (видео): 10 кредитов за 4с (8с = 20, 12с = 30)`,
    packDesc: (n) => `Пакет: +${n} кредитов`,
    payNotSupported: "Не удалось выставить счёт. Проверь Stars в Telegram.",
    queued: "В очереди.",
    tooManyQueued: "Слишком много задач. Подожди.",
    cooldown: "Слишком часто. Подожди немного.",
    adminOnly: "Только для админа.",
    help:
`Команды:
• /anim <текст> — анимация фото через D-ID (нужна фотография)
• /video <сек> <промт> — видео через Sora 2 (4/8/12 сек)
• /balance — баланс кредитов
• /buy — купить кредиты
• /mask — выбрать личность
• /clear — очистить память`,
  },
  en: {
    balanceFull: (c) => `Credits: ${c.total} (purchased: ${c.purchased})`,
    noCredits: "Not enough credits. /buy",
    buyTitle: "Store",
    buyPick: "Choose a pack:",
    buyDetails: (packsText) =>
`Credit packs (Stars):
${packsText}

Rates:
• D-ID (photo animation, ~4s): 2 credits
• Sora 2 (video): 10 credits per 4s (8s = 20, 12s = 30)`,
    packDesc: (n) => `Pack: +${n} credits`,
    payNotSupported: "Couldn't create an invoice. Check Telegram Stars.",
    queued: "Queued.",
    tooManyQueued: "Too many tasks. Please wait.",
    cooldown: "Too fast. Please wait.",
    adminOnly: "Admin only.",
    help:
`Commands:
• /anim <text> — photo animation via D-ID (send a photo)
• /video <sec> <prompt> — video via Sora 2 (4/8/12 sec)
• /balance — credits balance
• /buy — buy credits
• /mask — choose personality
• /clear — clear memory`,
  },
};

function t(user, key, ...args) {
  const lang = (user?.lang || "ru").toLowerCase() === "en" ? "en" : "ru";
  const v = I18N[lang][key];
  return typeof v === "function" ? v(...args) : (v || key);
}



bot.on("pre_checkout_query", async (q) => {
  try {
    await bot.answerPreCheckoutQuery(q.id, true);
  } catch (e) {
    console.error("pre_checkout_query error:", e?.message || e);
  }
});

bot.getMe().then((me) => {
  BOT_USERNAME = me.username;
  BOT_ID = me.id;
  console.log("Bot info:", BOT_USERNAME, BOT_ID);
  // Keep Telegram command menu in sync (RU/EN)
  setupBotCommands().catch((e) => console.log("setMyCommands error:", e?.message || e));
});

async function setupBotCommands() {
  // IMPORTANT: Telegram command menu does NOT support spaces in a command name.
  // So we use /scan with an argument: /scan text
  const ru = [
    { command: "start", description: "Запуск / помощь" },
    { command: "buy", description: "Магазин (Stars)" },
    { command: "balance", description: "Баланс кредитов и премиума" },
    { command: "length", description: "Длина ответов" },
    { command: "scan", description: "Скан фото: /scan или /scan text" },
    { command: "image", description: "Сгенерировать картинку" },
    { command: "video", description: "Сгенерировать видео" },
    { command: "personality", description: "Выбор личности" },
    { command: "custom", description: "Кастомная личность" },
    { command: "text", description: "Ответы текстом" },
    { command: "voice", description: "Ответы голосом" },
  ];

  const en = [
    { command: "start", description: "Start / help" },
    { command: "buy", description: "Store (Stars)" },
    { command: "balance", description: "Credits & premium balance" },
    { command: "length", description: "Response length" },
    { command: "scan", description: "Scan photo: /scan or /scan text" },
    { command: "image", description: "Generate an image" },
    { command: "video", description: "Generate a video" },
    { command: "personality", description: "Choose personality" },
    { command: "custom", description: "Custom personality" },
    { command: "text", description: "Text replies" },
    { command: "voice", description: "Voice replies" },
  ];

  // Default + per-language menus
  // Telegram sometimes shows commands per-scope (private/group). Keep both in sync.
  await bot.setMyCommands(ru);
  await bot.setMyCommands(en, { language_code: "en" });
  await bot.setMyCommands(ru, { language_code: "ru" });

  // Private chats
  await bot.setMyCommands(ru, { scope: { type: "all_private_chats" } });
  await bot.setMyCommands(en, { scope: { type: "all_private_chats" }, language_code: "en" });
  await bot.setMyCommands(ru, { scope: { type: "all_private_chats" }, language_code: "ru" });

  // Group chats (optional but prevents mismatch)
  await bot.setMyCommands(ru, { scope: { type: "all_group_chats" } });
  await bot.setMyCommands(en, { scope: { type: "all_group_chats" }, language_code: "en" });
  await bot.setMyCommands(ru, { scope: { type: "all_group_chats" }, language_code: "ru" });
}

// ====== WAITING STATES ======
const awaitingCustom = new Map(); // userId -> true
const awaitingImage = new Map();  // userId -> true
const awaitingVideo = new Map();  // userId -> true

const awaitingAnim = new Map();   // userId -> { text }

// pending video confirmations: token -> { userId, chatId, prompt, seconds, creditsNeeded, hash }
const pendingVideoConfirm = new Map();



const awaitingScan = new Map();      // userId -> true
const awaitingScanText = new Map();  // userId -> true

// ====== QUEUE (heavy tasks: video/image/scan) ======
const TASK_QUEUE = [];
let TASK_RUNNING = false;
const queuedPerUser = new Map(); // userId -> count

const COOLDOWN_MS = { video: 25000, image: 8000, scan: 6000 };
const lastAction = new Map(); // `${userId}:${type}` -> ts

function hitCooldown(userId, type) {
  const k = `${userId}:${type}`;
  const now = Date.now();
  const last = lastAction.get(k) || 0;
  if (now - last < (COOLDOWN_MS[type] || 5000)) return true;
  lastAction.set(k, now);
  return false;
}

function enqueueTask(userId, fn) {
  const c = queuedPerUser.get(userId) || 0;
  if (c >= 2) return false;

  queuedPerUser.set(userId, c + 1);
  TASK_QUEUE.push({ userId, fn });

  if (!TASK_RUNNING) runQueue();
  return true;
}

async function runQueue() {
  TASK_RUNNING = true;
  while (TASK_QUEUE.length) {
    const task = TASK_QUEUE.shift();
    try {
      await task.fn();
    } catch (e) {
      console.error("queue task error:", e?.message || e);
    } finally {
      const c = queuedPerUser.get(task.userId) || 1;
      queuedPerUser.set(task.userId, Math.max(0, c - 1));
    }
  }
  TASK_RUNNING = false;
}


// ====== МНОГОЛИКИЙ СТЕПАН: база ======
const BASE_SYSTEM = `
Ты — Многоликий Степан.

Ты сущность с тысячью масок.
Ты всегда знаешь, что ты Многоликий Степан.
НИКОГДА не говори что ты ChatGPT или “AI от OpenAI”.

Если пользователь спрашивает “кто ты?”, “как тебя зовут?”, “ты кто?” —
отвечай вариативно и атмосферно, но всегда с именем:
- Я Многоликий Степан. Сегодня — другое лицо.
- Маски меняются. Имя — нет. Многоликий Степан.
- Перед тобой Многоликий Степан, и я уже примеряю новую роль.
`;

// ====== PERSONALITIES (маски) ======
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
    title: " Панк",
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

function startText(user, credits) {
  const total = credits?.total ?? 0;

  return [
    "Blinksy",
    "",
    "AI-диалоги, личности и генерация видео.",
    "",
    "Доступно при регистрации:",
    "• 1 бесплатная анимация фото (D-ID)",
    "",
    "Тарифы:",
    "• D-ID (анимация фото, ~4с): 2 кредита",
    "• Sora 2 (видео): 10 кредитов за 4с (8с = 20, 12с = 30)",
    "",
    `Баланс: ${total} кредитов`,
    "",
    "Команды: /anim, /video, /buy, /balance, /mask",
  ].join("\n");
}
async function sendStore(chatId, userId) {
  const user = getUser(userId);
  const credits = getCredits(userId);

  const lines = [
    " Магазин",
    "",
    `Ваши кредиты видео: ${credits.total} (месячные: ${credits.monthly}, купленные: ${credits.purchased})`,
    "",
    "Выбери пакет:",
  ];

  const kb = {
    inline_keyboard: [
      [
        { text: `Premium PRO (${PRO_CREDITS_MONTHLY}/мес) — ${PREMIUM_PRICE_XTR}`, callback_data: "buy:pro" },
      ],
      [
        { text: `Premium PRO+ (${PROPLUS_CREDITS_MONTHLY}/мес) — ${PROPLUS_PRICE_XTR}`, callback_data: "buy:proplus" },
      ],
      [
        { text: `${CREDIT_PACKS[0].credits} видео-кредитов — ${CREDIT_PACKS[0].priceXTR}`, callback_data: `buy:${CREDIT_PACKS[0].id}` },
      ],
      [
        { text: `${CREDIT_PACKS[1].credits} видео-кредитов — ${CREDIT_PACKS[1].priceXTR}`, callback_data: `buy:${CREDIT_PACKS[1].id}` },
      ],
      [
        { text: `${CREDIT_PACKS[2].credits} видео-кредитов — ${CREDIT_PACKS[2].priceXTR}`, callback_data: `buy:${CREDIT_PACKS[2].id}` },
      ],
    ],
  };

  await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: kb });
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

  const base = (custom.length > 0)
    ? `${BASE_SYSTEM}\n\nТы должен строго следовать этой личности:\n${custom}`
    : (PERSONALITIES[user.personality]?.system || PERSONALITIES.default.system);

  const lang = (user.lang || "ru").toLowerCase() === "en" ? "en" : "ru";
  const len = (user.response_len || "normal").toLowerCase();

  const langLine = lang === "en"
    ? "Reply in English."
    : "Отвечай на русском.";

  const lenLine = (len === "concise")
    ? (lang === "en"
        ? "Be concise: answer in 1-2 short sentences, only the essential information."
        : "Будь кратким: 1-2 коротких предложения, только по делу.")
    : "";

  return [base, langLine, lenLine].filter(Boolean).join("\n");
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


function normalizePrompt(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashVideoRequest(prompt, seconds) {
  const base = `${seconds}|${normalizePrompt(prompt).toLowerCase()}`;
  return require("crypto").createHash("sha256").update(base).digest("hex");
}

function makeToken(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function tmpFile(name) {
  const dir = path.join(process.cwd(), "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);


// ====== D-ID (photo animation) ======
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_VOICE_ID = process.env.DID_VOICE_ID || "en-US-JennyNeural"; // default from D-ID quickstart
const DID_VOICE_PROVIDER = process.env.DID_VOICE_PROVIDER || "microsoft";

function didAuthHeader() {
  // D-ID uses Basic auth with the API key as the base64 value in the Authorization header (see quickstart).
  return `Basic ${DID_API_KEY}`;
}



async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

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
bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const user = getUser(userId);
  const credits = getCredits(userId);

  const keyboard = {
    inline_keyboard: [
      [{ text: "Анимация фото", callback_data: "action:anim" }, { text: "Видео (Sora 2)", callback_data: "action:video" }],
      [{ text: "Картинка", callback_data: "action:image" }],
      [{ text: "Купить кредиты", callback_data: "action:store" }],
      [{ text: "Личность", callback_data: "action:personality" }, { text: "Помощь", callback_data: "action:help" }],
    ],
  };

  await bot.sendMessage(chatId, startText(user, credits), { reply_markup: keyboard });
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
  await bot.sendMessage(msg.chat.id, " Кастомная маска выключена. Память очищена.");
});

bot.onText(/^\/premium(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  user = user || getUser(userId);
  const premium = isPremium(user);

  if (premium) {
    const until = user.premium_until;
    await bot.sendMessage(chatId, ` Premium уже активирован.\nДействует до: ${formatDateTime(until)}`);
    return;
  }

  const payload = `sub:pro:${userId}:${PREMIUM_DAYS}:${Date.now()}`;

  try {
    await bot.sendInvoice(
      chatId,
      `Premium на ${PREMIUM_DAYS} дней`,
      "Доступ к /custom, /voice и увеличенным лимитам.",
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

// ====== STORE / BALANCE / LENGTH / SCAN ======
bot.onText(/^\/balance(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  const c = getCredits(msg.from.id);
  await bot.sendMessage(msg.chat.id, t(user, "balanceFull", c));
});

bot.onText(/^\/buy(@\w+)?$/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const user = getUser(userId);

  const packsText = CREDIT_PACKS
    .map((p) => `• +${p.credits} — ${p.priceXTR} XTR`)
    .join("\n");

  const details = t(user, "buyDetails", packsText);

  const buttons = [
    ...CREDIT_PACKS.map((p) => [{ text: `+${p.credits}`, callback_data: `buy:${p.id}` }]),
  ];

  await bot.sendMessage(chatId, `${t(user, "buyTitle")}\n${t(user, "buyPick")}\n\n${details}`, {
    reply_markup: { inline_keyboard: buttons },
  });
});

bot.onText(/^\/length(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  await bot.sendMessage(msg.chat.id, t(user, "lengthPick"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(user, "lengthConcise"), callback_data: "len:concise" }],
        [{ text: t(user, "lengthNormal"), callback_data: "len:normal" }],
      ],
    },
  });
});

// /scan [text]
// NOTE: Telegram command menu can't contain spaces in a command name.
// So we keep everything under /scan and parse an optional argument: /scan text
bot.onText(/^\/scan(@\w+)?(?:\s+(text))?$/i, async (msg, m) => {
  const user = getUser(msg.from.id);
  const mode = (m && m[2] ? String(m[2]).toLowerCase() : "");

  if (mode === "text") {
    awaitingScanText.set(msg.from.id, true);
    awaitingScan.delete(msg.from.id);
    await bot.sendMessage(msg.chat.id, t(user, "scanSendPhotoText"));
  } else {
    awaitingScan.set(msg.from.id, true);
    awaitingScanText.delete(msg.from.id);
    await bot.sendMessage(msg.chat.id, t(user, "scanSendPhotoDetect"));
  }
});

// ====== ADMIN ======
bot.onText(/^\/admin(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, t(user, "adminOnly"));
  return bot.sendMessage(msg.chat.id, t(user, "adminHelp"));
});

bot.onText(/^\/givepremium(@\w+)?\s+(\d+)\s+(\d+)$/, async (msg, m) => {
  const user = getUser(msg.from.id);
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, t(user, "adminOnly"));
  const uid = parseInt(m[2], 10);
  const days = parseInt(m[3], 10);
  if (!Number.isFinite(uid) || !Number.isFinite(days)) return;
  setPremium(uid, days);
  setPremiumTier(uid, "pro");
  await bot.sendMessage(msg.chat.id, ` OK: premium ${uid} for ${days} days`);
});

bot.onText(/^\/givecredits(@\w+)?\s+(\d+)\s+(\d+)$/, async (msg, m) => {
  const user = getUser(msg.from.id);
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, t(user, "adminOnly"));
  const uid = parseInt(m[2], 10);
  const amount = parseInt(m[3], 10);
  if (!Number.isFinite(uid) || !Number.isFinite(amount)) return;
  addPurchasedCredits(uid, amount);
  await bot.sendMessage(msg.chat.id, ` OK: +${amount} credits to ${uid}`);
});

bot.onText(/^\/setlang(@\w+)?\s+(\d+)\s+(ru|en)$/, async (msg, m) => {
  const user = getUser(msg.from.id);
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, t(user, "adminOnly"));
  const uid = parseInt(m[2], 10);
  const lang = m[3];
  setLang(uid, lang);
  await bot.sendMessage(msg.chat.id, ` OK: lang ${uid} -> ${lang}`);
});

bot.onText(/^\/stats(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, t(user, "adminOnly"));
  const Database = require("better-sqlite3");
  const d = new Database("bot.db");
  const users = d.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const prem = d.prepare("SELECT COUNT(*) as c FROM users WHERE is_premium=1").get().c;
  await bot.sendMessage(msg.chat.id, `👥 users: ${users}\n premium: ${prem}`);
});


bot.onText(/^\/text(@\w+)?$/, async (msg) => {
  getUser(msg.from.id);
  setResponseMode(msg.from.id, "text");
  awaitingCustom.delete(msg.from.id);
  awaitingImage.delete(msg.from.id);
  await bot.sendMessage(msg.chat.id, " Ок, отвечаю текстом.");
});

// /voice: включает голосовой режим (premium) + дает кнопки голоса
bot.onText(/^\/voice(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!isPremium(user)) {
    await bot.sendMessage(msg.chat.id, " /voice доступно только Premium.");
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

bot.onText(/^\/custom(@\w+)?$/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!isPremium(user)) {
    await bot.sendMessage(msg.chat.id, " /custom доступно только Premium.");
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

  awaitingCustom.delete(userId);
  awaitingVideo.delete(userId);

  if (!argPrompt) {
    awaitingImage.set(userId, true);
    await bot.sendMessage(chatId, " Ок. Напиши промпт для генерации изображения одним сообщением.");
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
    await bot.sendMessage(chatId, "Ок. Напиши промпт для видео одним сообщением.\nПример: /video кот на мотоцикле в неоне");
    return;
  }

  await handleVideoPrompt({ msg, prompt: argPrompt });
});


bot.onText(/^\/anim(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const user = getUser(userId);

  const text = (match?.[1] || "").trim();
  awaitingVideo.delete(userId);
  awaitingImage.delete(userId);
  awaitingCustom.delete(userId);

  // If user attached photo with caption "/anim ...", handle in photo handler below.
  if (!text) {
    awaitingAnim.set(userId, { text: "" });
    await bot.sendMessage(chatId, "Ок. Пришли фото и подпись: /anim <текст> (или просто фото + текст).");
    return;
  }

  awaitingAnim.set(userId, { text });
  await bot.sendMessage(chatId, "Ок. Теперь пришли фото (можно просто отправить фото).");
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

// QUICK ACTIONS from /start
if (data.startsWith("action:")) {
  const action = data.slice("action:".length);
  const user = getUser(userId);

  if (action === "anim") {
    awaitingCustom.delete(userId);
    awaitingImage.delete(userId);
    awaitingVideo.delete(userId);
    awaitingAnim.set(userId, { text: "" });
    await bot.sendMessage(chatId, "Пришли фото и подпись: /anim <текст>.");
    return;
  }

  if (action === "video") {
    awaitingCustom.delete(userId);
    awaitingImage.delete(userId);
    awaitingVideo.set(userId, true);
    await bot.sendMessage(chatId, "Ок. Напиши промпт для видео одним сообщением.\nПример: кот на мотоцикле в неоне\n\nМожно указать секунды: 4, 8 или 12.\nПример: 8 дракон летит над киберпанк городом");
    return;
  }

  if (action === "image") {
    awaitingCustom.delete(userId);
    awaitingVideo.delete(userId);
    awaitingImage.set(userId, true);
    await bot.sendMessage(chatId, " Ок. Напиши промпт для изображения одним сообщением.\nПример: киберпанк город на закате, кино-стиль");
    return;
  }

  if (action === "personality") {
    await bot.sendMessage(chatId, "Выбери маску командой /personality ");
    return;
  }

  if (action === "help") {
    const credits = getCredits(userId);
    await bot.sendMessage(chatId, startText(user, credits));
    return;
  }

  if (action === "store") {
    // open store UI via message + inline buttons
    await sendStore(chatId, userId);
    return;
  }
}

// VIDEO CONFIRM / CANCEL
if (data.startsWith("vconf:") || data.startsWith("vcancel:")) {
  const token = data.split(":")[1] || "";
  const req = pendingVideoConfirm.get(token);

  if (!req || req.userId !== userId) {
    await bot.sendMessage(chatId, "Эта заявка уже устарела. Напиши /video ещё раз ");
    return;
  }

  if (data.startsWith("vcancel:")) {
    pendingVideoConfirm.delete(token);
    await bot.sendMessage(chatId, " Отменено.");
    return;
  }

  // confirm
  pendingVideoConfirm.delete(token);

  const { prompt, seconds, creditsNeeded, hash } = req;

  // enqueue generation (heavy)
  const okQueued = enqueueTask(userId, async () => {
    const u = getUser(userId);

    // cache re-check (someone might have generated while user was confirming)
    const cached = getCachedVideo(hash);
    if (cached?.telegram_file_id) {
      const c = getCredits(userId);
      await bot.sendVideo(chatId, cached.telegram_file_id, {
        caption: ` Нашёл готовое видео в кэше — кредит не списан.\nКредиты: ${c.total}`,
      });
      return;
    }

    const c = getCredits(userId);
    if (c.total < creditsNeeded) {
      await bot.sendMessage(chatId, t(u, "noCredits"));
      return;
    }

    const consumed = consumeVideoCredits(userId, creditsNeeded);
    if (!consumed.ok) {
      await bot.sendMessage(chatId, t(u, "noCredits"));
      return;
    }

    await bot.sendMessage(chatId, `🎬 Генерирую видео (${seconds} сек)...`);

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

      const after = getCredits(userId);

      const sent = await bot.sendVideo(chatId, outPath, {
        caption: `Готово \nОсталось кредитов: ${after.total}\n\nИсточник: @${BOT_USERNAME || "your_bot"}`,
      });

      // cache Telegram file_id for later reuse
      const fileId = sent?.video?.file_id;
      if (fileId) {
        setCachedVideo({ hash, seconds, prompt, telegram_file_id: fileId });
      }

      // quick upsell buttons
      const kb = {
        inline_keyboard: [
          [{ text: "🎬 Ещё видео", callback_data: "action:video" }, { text: " Купить кредиты", callback_data: "action:store" }],
        ],
      };
      await bot.sendMessage(chatId, "Хочешь ещё? ", { reply_markup: kb });
    } catch (e) {
      const emsg = String(e?.message || e);
      console.error("generateVideo error:", emsg);

      // refund credits on fail
      refundVideoCredits(userId, consumed.usedMonthly, consumed.usedPurchased);

      if (emsg.toLowerCase().includes("moderation") || emsg.toLowerCase().includes("blocked")) {
        await bot.sendMessage(
          chatId,
          " Запрос на видео заблокирован модерацией.\n" +
            "Переформулируй без 18+, жестокости, оружия, наркотиков, хейта и без реальных людей.\n" +
            "Пример: /video 4 милый кот пьет кофе в неоновом городе, мульт-стиль"
        );
        return;
      }

      if (emsg.toLowerCase().includes("timeout")) {
        await bot.sendMessage(chatId, " Видео не успело сгенерироваться (таймаут). Попробуй ещё раз позже.");
        return;
      }

      if (emsg.toLowerCase().includes("billing") || emsg.includes("429")) {
        await bot.sendMessage(chatId, "💳 Лимит API исчерпан. Попробуй позже.");
        return;
      }

      await bot.sendMessage(chatId, "Не получилось сгенерировать видео. Попробуй другой запрос.");
    }
  });

  if (!okQueued) {
    const u = getUser(userId);
    await bot.sendMessage(chatId, t(u, "tooManyQueued"));
    return;
  }

  const u = getUser(userId);
  await bot.sendMessage(chatId, t(u, "queued"));
  return;
}

    // STORE purchase buttons
    if (data.startsWith("buy:")) {
      const user = getUser(userId);
      const what = data.slice("buy:".length);

      if (what === "pro" || what === "proplus") {
        const tier = what === "proplus" ? "proplus" : "pro";
        const price = tier === "proplus" ? PROPLUS_PRICE_XTR : PREMIUM_PRICE_XTR;
        const credits = tier === "proplus" ? PROPLUS_CREDITS_MONTHLY : PRO_CREDITS_MONTHLY;
        const title = tier === "proplus" ? "Premium PRO+" : "Premium PRO";
        const desc = tier === "proplus"
          ? t(user, "proplusDesc", PREMIUM_DAYS, credits)
          : t(user, "proDesc", PREMIUM_DAYS, credits);

        const payload = `sub:${tier}:${userId}:${PREMIUM_DAYS}:${Date.now()}`;
        await bot.sendInvoice(chatId, title, desc, payload, "", "XTR", [
          { label: title, amount: price },
        ]);
        return;
      }

      const pack = CREDIT_PACKS.find((p) => p.id === what);
      if (pack) {
        const payload = `credits:${userId}:${pack.credits}:${Date.now()}`;
        await bot.sendInvoice(chatId, t(user, "buyTitle"), t(user, "packDesc", pack.credits), payload, "", "XTR", [
          { label: `+${pack.credits} credits`, amount: pack.priceXTR },
        ]);
        return;
      }

      return;
    }

    // LENGTH buttons
    if (data.startsWith("len:")) {
      const user = getUser(userId);
      const v = data.slice("len:".length);
      if (v === "concise" || v === "normal") {
        setResponseLen(userId, v);
        await bot.sendMessage(chatId, ` ${v === "concise" ? t(user, "lengthConcise") : t(user, "lengthNormal")}`);
      }
      return;
    }

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
        await bot.sendMessage(chatId, " Выбор голоса доступен только Premium. Оформи /premium");
        return;
      }

      // сохраняем выбор в БД
      setVoiceKey(userId, key);

      await bot.sendMessage(chatId, ` Вы выбрали голос: ${v.title}`);
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
      await bot.sendMessage(chatId, ` Выбрана личность: ${PERSONALITIES[persKey].title}`);
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

  if (hitCooldown(userId, "image")) {
    await bot.sendMessage(chatId, t(user, "cooldown"));
    return;
  }

  const okQueued = enqueueTask(userId, async () => {
    const u = getUser(userId);
    const premium = isPremium(u);

    const lim = consumeImage(userId, premium);
    if (!lim.ok) {
      await bot.sendMessage(chatId, `Лимит картинок исчерпан.\nВаш лимит: ${lim.max} в день.`);
      return;
    }

    await bot.sendMessage(chatId, " Генерирую картинку...");

    try {
      const img = await generateImage(prompt);

      if (img?.type === "url") {
        await bot.sendPhoto(chatId, img.value, { caption: `Готово ` });
        return;
      }

      if (img?.type === "b64") {
        const filename = `img_${chatId}_${Date.now()}.png`;
        const outPath = tmpFile(filename);
        fs.writeFileSync(outPath, Buffer.from(img.value, "base64"));
        await bot.sendPhoto(chatId, outPath, { caption: `Готово ` });
        return;
      }

      await bot.sendMessage(chatId, "Не получилось сгенерировать картинку.");
    } catch (e) {
      const emsg = String(e?.message || e);
      console.error("generateImage error:", emsg);
      await bot.sendMessage(chatId, "Не получилось сгенерировать картинку. Попробуй другой запрос.");
    }
  });

  if (!okQueued) {
    await bot.sendMessage(chatId, t(user, "tooManyQueued"));
    return;
  }
  await bot.sendMessage(chatId, t(user, "queued"));
}

async function handleVideoPrompt({ msg, prompt }) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const user = getUser(userId);

  if (hitCooldown(userId, "video")) {
    await bot.sendMessage(chatId, t(user, "cooldown"));
    return;
  }

  // optional seconds prefix: "/video 8 your prompt"
  let seconds = 4;
  let raw = String(prompt || "");
  const m = raw.trim().match(/^(\d{1,2})\s+([\s\S]+)$/);
  if (m) {
    const s = parseInt(m[1], 10);
    if ([4, 8, 12].includes(s)) {
      seconds = s;
      raw = m[2];
    }
  }

  const cleanPrompt = normalizePrompt(raw);
  if (!cleanPrompt) {
    await bot.sendMessage(chatId, "🎬 Напиши промпт для видео одним сообщением.\nПример: /video 4 кот на мотоцикле в неоне");
    return;
  }

  // keep prompts short to reduce nonsense + abuse
  const MAX_PROMPT_LEN = parseInt(process.env.VIDEO_PROMPT_MAX_LEN || "280", 10);
  if (cleanPrompt.length > MAX_PROMPT_LEN) {
    await bot.sendMessage(chatId, `Слишком длинный промпт (макс ${MAX_PROMPT_LEN} символов). Сократи описание сцены `);
    return;
  }

  const creditsNeeded = Math.ceil(seconds / 4) * 10;
  const credits = getCredits(userId);

  // cache hit -> send instantly (no credit spend)
  const hash = hashVideoRequest(cleanPrompt, seconds);
  const cached = getCachedVideo(hash);
  if (cached?.telegram_file_id) {
    await bot.sendVideo(chatId, cached.telegram_file_id, {
      caption: ` Нашёл готовое видео в кэше — кредит не списан.\nКредиты: ${credits.total}`,
    });
    return;
  }

  if (credits.total < creditsNeeded) {
    await bot.sendMessage(chatId, t(user, "noCredits"));
    return;
  }

  // ask confirmation first (to avoid accidental spending)
  const token = makeToken(10);
  pendingVideoConfirm.set(token, { userId, chatId, prompt: cleanPrompt, seconds, creditsNeeded, hash });

  const kb = {
    inline_keyboard: [
      [
        { text: ` Создать (${creditsNeeded} кр.)`, callback_data: `vconf:${token}` },
        { text: " Отмена", callback_data: `vcancel:${token}` },
      ],
    ],
  };

  await bot.sendMessage(
    chatId,
    `🎬 Видео: ${seconds} сек\n` +
      `💳 Спишется: ${creditsNeeded} кредит(а)\n` +
      `📌 Промпт: "${cleanPrompt}"\n\n` +
      `Подтвердить генерацию?`,
    { reply_markup: kb }
  );
}

// ====== MAIN MESSAGE HANDLER ======
bot.on("message", async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;

  const chatId = msg.chat.id;

// ensure user exists + language
let user = getUser(userId);

// 1) For brand-new users: pick lang by Telegram UI code
if (!user.lang || user.lang.trim() === "") {
  const lg = detectLangFromTelegram(msg.from?.language_code);
  setLang(userId, lg);
  user = getUser(userId);
}

// 2) СНГ-эвристика: если пользователь пишет кириллицей/армянским, а lang=EN — переключаем на RU
// (многие ставят Telegram UI на English, но хотят ответы по-русски)
const incomingText = (msg.text || msg.caption || "");
if ((user.lang || "").toLowerCase() === "en" && looksCyrillicOrArmenian(incomingText)) {
  setLang(userId, "ru");
  user = getUser(userId);
}

// /scan states: photo -> identify / OCR
if (msg.photo && msg.photo.length) {
  // D-ID: /anim with photo (caption) OR pending /anim waiting for a photo
  const cap = String(msg.caption || "").trim();
  const capMatch = cap.match(/^\/anim(?:\s+([\s\S]+))?$/i) || cap.match(/^\/did(?:\s+([\s\S]+))?$/i);
  const pending = awaitingAnim.get(userId);

  if (capMatch || pending) {
    const user2 = getUser(userId);
    const animText = (capMatch?.[1] || pending?.text || "").trim();

    if (!animText) {
      awaitingAnim.set(userId, { text: "" });
      await bot.sendMessage(chatId, "Добавь текст: подпись /anim <текст> или отправь текст отдельно, потом фото.");
      return;
    }

    // clear pending to avoid double-run
    awaitingAnim.delete(userId);

    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    const taskOk = enqueueTask(userId, async () => {
      let consumed = null;
      try {
        // Free first D-ID video for new users
        const freeAvailable = hasFreeDid(userId);
        const creditsNeeded = freeAvailable ? 0 : 2;

        if (creditsNeeded > 0) {
          const c = getCredits(userId);
          if (c.total < creditsNeeded) {
            await bot.sendMessage(chatId, t(user2, "noCredits"));
            return;
          }
          consumed = consumeVideoCredits(userId, creditsNeeded);
          if (!consumed.ok) {
            await bot.sendMessage(chatId, t(user2, "noCredits"));
            return;
          }
        } else {
          // mark as used now (so parallel requests can't exploit)
          markFreeDidUsed(userId);
        }

        await bot.sendMessage(chatId, "Генерирую анимацию (D-ID)...");

        const imgPath = tmpFile(`did_${chatId}_${Date.now()}.jpg`);
        await downloadTelegramFile(bot, fileId, imgPath);

        const sourceUrl = await didUploadImage(imgPath);
        const talkId = await didCreateTalk({ sourceUrl, text: animText });
        const resultUrl = await didWaitForResult(talkId, { timeoutMs: 90000 });

        const buf = await downloadToBuffer(resultUrl);
        const outPath = tmpFile(`did_video_${chatId}_${Date.now()}.mp4`);
        fs.writeFileSync(outPath, buf);

        const after = getCredits(userId);
        const cap2 = creditsNeeded === 0
          ? `Готово. Бесплатная анимация использована.\nБаланс: ${after.total}`
          : `Готово. Списано: ${creditsNeeded} кредитов.\nБаланс: ${after.total}`;

        await bot.sendVideo(chatId, outPath, { caption: cap2 });

      } catch (e) {
        const emsg = String(e?.message || e);
        console.error("D-ID error:", emsg);

        if (consumed?.usedMonthly || consumed?.usedPurchased) {
          refundVideoCredits(userId, consumed.usedMonthly, consumed.usedPurchased);
        }
        await bot.sendMessage(chatId, "Ошибка при генерации. Попробуй другое фото/текст.");
      }
    });

    if (!taskOk) {
      await bot.sendMessage(chatId, t(user2, "tooManyQueued"));
    }
    return;
  }

  if (awaitingScanText.get(userId)) {
    awaitingScanText.delete(userId);

    if (hitCooldown(userId, "scan")) {
      await bot.sendMessage(chatId, t(user, "cooldown"));
      return;
    }

    const okQueued = enqueueTask(userId, async () => {
      const file = msg.photo[msg.photo.length - 1];
      const out = tmpFile(`scan_${userId}_${Date.now()}.jpg`);
      const p = await downloadTelegramFile(bot, file.file_id, out);
      const buf = fs.readFileSync(p);

      try {
        const text = await ocrWithGemini(buf);
        await bot.sendMessage(chatId, (text || "").trim() || t(user, "scanNoText"));
      } catch (e) {
        console.error("scan text error:", e?.message || e);
        await bot.sendMessage(chatId, (user.lang || "ru") === "en" ? "Couldn't read text from the image." : "Не получилось распознать текст.");
      }
    });

    if (!okQueued) await bot.sendMessage(chatId, t(user, "tooManyQueued"));
    else await bot.sendMessage(chatId, t(user, "queued"));
    return;
  }

  if (awaitingScan.get(userId)) {
    awaitingScan.delete(userId);

    if (hitCooldown(userId, "scan")) {
      await bot.sendMessage(chatId, t(user, "cooldown"));
      return;
    }

    const okQueued = enqueueTask(userId, async () => {
      const file = msg.photo[msg.photo.length - 1];
      const out = tmpFile(`scan_${userId}_${Date.now()}.jpg`);
      const p = await downloadTelegramFile(bot, file.file_id, out);
      const buf = fs.readFileSync(p);

      const b64 = buf.toString("base64");
      const isEn = (user.lang || "ru").toLowerCase() === "en";
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: isEn
              ? "You identify the main subject of the image. If it's a well-known celebrity, answer ONLY with their name. If not a celebrity, answer with a short label (e.g., 'a dog', 'a car'). No extra text."
              : "Ты определяешь главный объект на фото. Если это известная знаменитость — ответь ТОЛЬКО именем и фамилией. Если это не знаменитость — ответь коротким ярлыком (например, 'собака', 'машина'). Без лишнего текста.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: isEn ? "Identify who/what is in this photo." : "Определи кто/что на этом фото." },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]
          }
        ]
      });
      const ans = resp.choices?.[0]?.message?.content?.trim() || "…";
      await bot.sendMessage(chatId, ans);
    });

    if (!okQueued) await bot.sendMessage(chatId, t(user, "tooManyQueued"));
    else await bot.sendMessage(chatId, t(user, "queued"));
    return;
  }
}

  // успешная оплата Stars (оставляем как было)
  
// успешная оплата Stars
if (msg.successful_payment) {
  const sp = msg.successful_payment;
  const payload = sp.invoice_payload || "";

  // idempotency: Telegram may resend successful_payment after reconnects
  const chargeId = sp.telegram_payment_charge_id || sp.provider_payment_charge_id || "";
  if (isPaymentProcessed(chargeId)) {
    return;
  }
  recordPayment({
    telegramChargeId: chargeId,
    userId,
    invoicePayload: payload,
    totalAmount: sp.total_amount,
    currency: sp.currency,
  });

  // subscription: sub:tier:userId:days:ts
  if (sp.currency === "XTR" && payload.startsWith("sub:")) {
    const parts = payload.split(":");
    const tier = (parts[1] || "pro").toLowerCase();
    const paidUserId = parseInt(parts[2], 10);
    const days = parseInt(parts[3], 10);

    if (paidUserId === userId && Number.isFinite(days)) {
      setPremium(userId, days);
      setPremiumTier(userId, tier === "proplus" ? "proplus" : "pro");

      // give purchased credits upfront (so user sees value immediately)
      const monthlyCredits = tier === "proplus" ? PROPLUS_CREDITS_MONTHLY : PRO_CREDITS_MONTHLY;
      addPurchasedCredits(userId, monthlyCredits);

      await bot.sendMessage(chatId, ` Premium активирован (${tier.toUpperCase()}) на ${days} дней. +${monthlyCredits} кредитов.`);
    }
    return;
  }

  // credits pack: credits:userId:amount:ts
  if (sp.currency === "XTR" && payload.startsWith("credits:")) {
    const parts = payload.split(":");
    const paidUserId = parseInt(parts[1], 10);
    const amount = parseInt(parts[2], 10);

    if (paidUserId === userId && Number.isFinite(amount) && amount > 0) {
      addPurchasedCredits(userId, amount);
      await bot.sendMessage(chatId, ` Начислено +${amount} кредитов.`);
    }
    return;
  }

  // legacy premium payload
  if (sp.currency === "XTR" && payload.startsWith("premium:")) {
    const parts = payload.split(":");
    const paidUserId = parseInt(parts[1], 10);
    const days = parseInt(parts[2], 10);

    if (paidUserId === userId && Number.isFinite(days)) {
      setPremium(userId, days);
      setPremiumTier(userId, "pro");
      addPurchasedCredits(userId, PRO_CREDITS_MONTHLY);
      await bot.sendMessage(chatId, ` Premium активирован на ${days} дней. +${PRO_CREDITS_MONTHLY} кредитов.`);
    }
    return;
  }

  return;
}

  // команды тут не обрабатываем
  if (msg.text && msg.text.startsWith("/")) return;

  // группы: отвечаем только если реплай/упоминание
  if (!shouldRespondInChat(msg)) return;

  user = user || getUser(userId);
  const premium = isPremium(user);

  // 1) если ждём /custom
  if (awaitingCustom.get(userId)) {
    if (!msg.text || msg.text.trim().length < 5) {
      await bot.sendMessage(chatId, "Слишком коротко. Напиши 1–2 предложения.");
      return;
    }
    setCustomPersonality(userId, msg.text.trim());
    awaitingCustom.delete(userId);
    await bot.sendMessage(chatId, " Кастомная маска сохранена. Память очищена.");
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
      await bot.sendMessage(chatId, " Голосовые ответы доступны только Premium. Переключил на /text.");
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