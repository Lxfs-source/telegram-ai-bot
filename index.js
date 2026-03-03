// index.js (Blinksy)
// Node 18+ required (global fetch)

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const TelegramBot = require("node-telegram-bot-api");

const { webSearch } = require("./search");
const { downloadTelegramFile } = require("./telegramFiles");
const {
  chatOpenAI,
  generateImage,
  generateVideoToBuffer, // sora-2
  decideSearch,
} = require("./ai");

const {
  getUser,
  setPersonality,
  setCustomPersonality,
  addMessage,
  getLastMessages,
  // credits
  getCredits,
  consumeVideoCredits,
  refundVideoCredits,
  addPurchasedCredits,
  // payments
  isPaymentProcessed,
  recordPayment,
} = require("./database");

// ------------------ CONFIG ------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN not found");
  process.exit(1);
}

if (!global.fetch) {
  console.error("This bot requires Node 18+ (global fetch).");
  process.exit(1);
}

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_VOICE_PROVIDER = process.env.DID_VOICE_PROVIDER || "microsoft";
const DID_VOICE_ID = process.env.DID_VOICE_ID || "en-US-JennyNeural";

// Credit costs
const DID_COST = 1;         // D-ID: 1 credit per ~4s (cheap)
const SORA_COST_MULT = 10;  // Sora: 4s=10, 8s=20, 12s=30

// Credit packs (Stars). Adjust as needed:
const CREDIT_PACKS = [
  { id: "pack50", credits: 50, priceXTR: parseInt(process.env.CREDITS50_PRICE_XTR || "299", 10) },
  { id: "pack110", credits: 110, priceXTR: parseInt(process.env.CREDITS110_PRICE_XTR || "599", 10) },
  { id: "pack250", credits: 250, priceXTR: parseInt(process.env.CREDITS250_PRICE_XTR || "1199", 10) },
];

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ------------------ HELPERS ------------------

function tmpFile(name) {
  const dir = path.join(process.cwd(), "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function parseSecondsAndPrompt(raw) {
  const t = String(raw || "").trim();
  if (!t) return { seconds: 4, prompt: "" };

  const m = t.match(/^(\d+)\s+([\s\S]+)$/);
  if (m) {
    const sec = parseInt(m[1], 10);
    if ([4, 8, 12].includes(sec)) return { seconds: sec, prompt: m[2].trim() };
  }
  return { seconds: 4, prompt: t };
}

function soraCredits(seconds) {
  const base = Math.max(1, Math.round(seconds / 4));
  return base * SORA_COST_MULT;
}

function minimalStartText(credits) {
  return [
    "Blinksy",
    "",
    "Анимация фото (D-ID) и видео (Sora 2).",
    "",
    `Баланс: ${credits.total} (месячные: ${credits.monthly}, купленные: ${credits.purchased})`,
    "",
    "Тарифы:",
    `• Фото→видео (D-ID): ${DID_COST} кредит за ~4 сек`,
    `• Видео (Sora 2): ${SORA_COST_MULT} кредитов за 4 сек`,
    "",
    "Бесплатный старт: 1 видео доступно новым пользователям.",
    "",
    "Команды:",
    "/anim <текст> — оживить фото голосом",
    "/video <сек> <промпт> — видео Sora 2 (4/8/12)",
    "/image <промпт> — генерация картинки",
    "/buy — купить кредиты",
    "/personality — выбор стиля общения",
  ].join("\n");
}

async function ffmpegFaststart(inPath) {
  // Repack MP4 so Telegram clients read duration/audio correctly (moov atom at start)
  const outPath = inPath.replace(/\.mp4$/i, "") + "_fs.mp4";
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-i", inPath, "-c", "copy", "-movflags", "+faststart", outPath], {
      stdio: "ignore",
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${code}`))));
  });
  return outPath;
}

async function ffprobeDurationSeconds(filePath) {
  return await new Promise((resolve, reject) => {
    let out = "";
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${code}`));
      const dur = parseFloat(String(out).trim());
      resolve(Number.isFinite(dur) ? dur : 0);
    });
  });
}

async function ffmpegPadToSeconds(inPath, targetSeconds = 4) {
  const dur = await ffprobeDurationSeconds(inPath).catch(() => 0);
  if (dur >= targetSeconds || dur <= 0) return inPath;

  const delta = Math.max(0, targetSeconds - dur);
  const outPath = inPath.replace(/\.mp4$/i, "") + `_pad${targetSeconds}.mp4`;

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inPath,
      "-vf", `tpad=stop_mode=clone:stop_duration=${delta}`,
      "-af", `apad=pad_dur=${delta}`,
      "-t", String(targetSeconds),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outPath,
    ];
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg pad failed: ${code}`))));
  });

  return outPath;
}

// ------------------ D-ID API ------------------

function didAuthHeader() {
  if (!DID_API_KEY) throw new Error("DID_API_KEY is not set");
  return `Basic ${Buffer.from(DID_API_KEY + ":").toString("base64")}`;
}

// Upload local image file -> returns source_url
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

  const body = Buffer.concat([Buffer.from(head, "utf8"), buf, Buffer.from(tail, "utf8")]);

  const res = await fetch("https://api.d-id.com/images", {
    method: "POST",
    headers: {
      Authorization: didAuthHeader(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`D-ID image upload failed: ${res.status} ${JSON.stringify(json)}`);

  const url = json.url || json.source_url || json.image_url;
  if (!url) throw new Error(`D-ID image upload: no url in response: ${JSON.stringify(json)}`);
  return url;
}

async function didCreateTalk({ sourceUrl, text }) {
  const payload = {
    source_url: sourceUrl,
    script: {
      type: "text",
      input: text,
      provider: {
        type: DID_VOICE_PROVIDER,
        voice_id: DID_VOICE_ID,
      },
    },
    config: {
      stitch: true,
    },
  };

  const res = await fetch("https://api.d-id.com/talks", {
    method: "POST",
    headers: {
      Authorization: didAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`D-ID create talk failed: ${res.status} ${JSON.stringify(json)}`);
  if (!json.id) throw new Error(`D-ID create talk: missing id: ${JSON.stringify(json)}`);
  return json.id;
}

async function didWaitForResult(talkId, { timeoutMs = 180000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      method: "GET",
      headers: { Authorization: didAuthHeader() },
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`D-ID get talk failed: ${res.status} ${JSON.stringify(json)}`);

    const status = String(json.status || "");
    if (status === "done" && json.result_url) return json.result_url;
    if (status === "error" || status === "failed") throw new Error(`D-ID talk failed: ${JSON.stringify(json)}`);

    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("D-ID timeout");
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  if (!res.ok) {
    const preview = buf.slice(0, 400).toString("utf8");
    throw new Error(`Download failed: ${res.status} ct=${ct} body=${preview}`);
  }

  // If D-ID returns HTML/JSON on edge cases, don't treat it as mp4
  const looksLikeVideo = ct.startsWith("video/") || ct.includes("mp4") || ct.includes("octet-stream");
  if (!looksLikeVideo || buf.length < 200_000) {
    const preview = buf.slice(0, 400).toString("utf8");
    throw new Error(`Non-video response: ct=${ct} bytes=${buf.length} body=${preview}`);
  }

  return buf;
}

// ------------------ STATE ------------------

const awaitingAnimPhoto = new Map();      // userId -> { text }
const pendingVideoConfirm = new Map();    // token -> request

// ------------------ COMMAND MENU ------------------

(async () => {
  try {
    await bot.setMyCommands([
      { command: "start", description: "Главное меню" },
      { command: "anim", description: "Оживить фото (D-ID): /anim текст" },
      { command: "video", description: "Видео Sora 2: /video 4 промпт" },
      { command: "image", description: "Картинка: /image промпт" },
      { command: "buy", description: "Купить кредиты" },
      { command: "personality", description: "Выбор стиля общения" },
      { command: "custom_off", description: "Выключить кастомный стиль" },
    ]);
  } catch (e) {
    console.log("setMyCommands error:", e?.message || e);
  }
})();

// ------------------ /start ------------------

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  getUser(userId); // ensures row exists + signup credits handled in database.js
  const credits = getCredits(userId);

  const kb = {
    inline_keyboard: [
      [
        { text: "Анимация фото (D-ID)", callback_data: "action:anim" },
        { text: "Видео (Sora 2)", callback_data: "action:video" },
      ],
      [
        { text: "Купить кредиты", callback_data: "action:buy" },
        { text: "Стиль общения", callback_data: "action:personality" },
      ],
    ],
  };

  await bot.sendMessage(chatId, minimalStartText(credits), { reply_markup: kb });
});

// ------------------ /buy ------------------

async function sendStore(chatId, userId) {
  const credits = getCredits(userId);
  const lines = [
    "Кредиты",
    "",
    `Баланс: ${credits.total} (месячные: ${credits.monthly}, купленные: ${credits.purchased})`,
    "",
    "Пакеты:",
    ...CREDIT_PACKS.map((p) => `• +${p.credits} — ${p.priceXTR} Stars`),
    "",
    "Расход:",
    `• D-ID: ${DID_COST} кредит`,
    `• Sora 2: ${SORA_COST_MULT} кредитов за 4 сек`,
  ];

  const kb = {
    inline_keyboard: CREDIT_PACKS.map((p) => [
      { text: `+${p.credits} — ${p.priceXTR}⭐`, callback_data: `buy:${p.id}` },
    ]),
  };

  await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: kb });
}

bot.onText(/^\/buy(@\w+)?$/, async (msg) => {
  await sendStore(msg.chat.id, msg.from.id);
});

async function sendStarsInvoice(chatId, userId, pack) {
  const payload = `credits:${pack.id}:${userId}:${Date.now()}`;
  await bot.sendInvoice(chatId, {
    title: `Blinksy: +${pack.credits} кредитов`,
    description: `Пакет кредитов +${pack.credits}`,
    payload,
    provider_token: "", // Stars
    currency: "XTR",
    prices: [{ label: `+${pack.credits} credits`, amount: pack.priceXTR }],
  });
}

bot.on("pre_checkout_query", async (q) => {
  try {
    await bot.answerPreCheckoutQuery(q.id, true);
  } catch (e) {
    console.log("answerPreCheckoutQuery error:", e?.message || e);
  }
});

bot.on("message", async (msg) => {
  // successful payment handler
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
      const key = sp.provider_payment_charge_id || sp.telegram_payment_charge_id || sp.invoice_payload;
      if (isPaymentProcessed(key)) {
        await bot.sendMessage(chatId, "Платёж уже обработан.");
        return;
      }

      const payload = sp.invoice_payload || "";
      const parts = payload.split(":");
      const packId = parts[1] || "";
      const pack = CREDIT_PACKS.find((p) => p.id === packId);

      if (!pack) {
        await bot.sendMessage(chatId, "Не удалось определить пакет. Напиши /buy");
        return;
      }

      addPurchasedCredits(userId, pack.credits);
      recordPayment(key);

      const after = getCredits(userId);
      await bot.sendMessage(chatId, `Готово. Баланс: ${after.total}`);
    } catch (e) {
      console.log("payment handler error:", e?.message || e);
      await bot.sendMessage(msg.chat.id, "Ошибка обработки платежа. Напиши /buy");
    }
    return;
  }
});

// ------------------ /personality ------------------

bot.onText(/^\/personality(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  const kb = {
    inline_keyboard: [
      [{ text: "Default", callback_data: "pers:default" }, { text: "Friendly", callback_data: "pers:friendly" }],
      [{ text: "Strict", callback_data: "pers:strict" }, { text: "Funny", callback_data: "pers:funny" }],
    ],
  };

  await bot.sendMessage(chatId, "Выбери стиль:", { reply_markup: kb });
});

bot.onText(/^\/custom_off(@\w+)?$/, async (msg) => {
  const userId = msg.from.id;
  setCustomPersonality(userId, "");
  awaitingAnimPhoto.delete(userId);
  await bot.sendMessage(msg.chat.id, "Кастомный стиль выключен.");
});

// ------------------ /image ------------------

bot.onText(/^\/image(@\w+)?\s+([\s\S]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const prompt = (match?.[2] || "").trim();
  if (!prompt) return;

  await bot.sendMessage(chatId, "Генерирую изображение...");

  try {
    const buf = await generateImage({ prompt });
    const outPath = tmpFile(`img_${chatId}_${Date.now()}.png`);
    fs.writeFileSync(outPath, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    await bot.sendPhoto(chatId, outPath, { caption: "Готово." });
  } catch (e) {
    console.log("image error:", e?.message || e);
    await bot.sendMessage(chatId, "Не получилось сгенерировать изображение.");
  }
});

// ------------------ /anim (D-ID) ------------------

bot.onText(/^\/anim(@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!DID_API_KEY) {
    await bot.sendMessage(chatId, "D-ID не настроен (нет DID_API_KEY).");
    return;
  }

  const text = (match?.[2] || "").trim();
  if (!text) {
    await bot.sendMessage(chatId, "Формат: /anim текст\nПотом пришли фото одним сообщением.");
    return;
  }

  awaitingAnimPhoto.set(userId, { text });
  await bot.sendMessage(chatId, "Пришли фото (одним сообщением).");
});

// ------------------ /video (Sora 2) ------------------

bot.onText(/^\/video(@\w+)?\s+([\s\S]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const raw = (match?.[2] || "").trim();
  const { seconds, prompt } = parseSecondsAndPrompt(raw);

  if (!prompt) {
    await bot.sendMessage(chatId, "Формат: /video 4 промпт");
    return;
  }

  const creditsNeeded = soraCredits(seconds);
  const credits = getCredits(userId);

  if (credits.total < creditsNeeded) {
    await bot.sendMessage(chatId, `Не хватает кредитов. Нужно: ${creditsNeeded}, у тебя: ${credits.total}. /buy`);
    return;
  }

  const token = crypto.randomBytes(12).toString("hex");
  pendingVideoConfirm.set(token, { userId, chatId, prompt, seconds, creditsNeeded });

  const kb = {
    inline_keyboard: [
      [{ text: `Подтвердить (${creditsNeeded} кредитов)`, callback_data: `vconf:${token}` }],
      [{ text: "Отмена", callback_data: `vcancel:${token}` }],
    ],
  };

  await bot.sendMessage(
    chatId,
    `Видео (Sora 2)\nСек: ${seconds}\nСтоимость: ${creditsNeeded} кредитов\n\nПромпт:\n${prompt}`,
    { reply_markup: kb }
  );
});

// ------------------ CALLBACKS ------------------

bot.on("callback_query", async (q) => {
  const data = q.data || "";
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  if (!chatId || !userId) return;

  try {
    if (data.startsWith("action:")) {
      const a = data.split(":")[1];

      if (a === "buy") return sendStore(chatId, userId);

      if (a === "anim") {
        return bot.sendMessage(chatId, "Команда: /anim текст\nПотом пришли фото.");
      }

      if (a === "video") {
        return bot.sendMessage(chatId, "Команда: /video 4 промпт\nПоддержка секунд: 4, 8, 12.");
      }

      if (a === "personality") {
        return bot.sendMessage(chatId, "Команда: /personality");
      }
    }

    if (data.startsWith("pers:")) {
      const p = data.split(":")[1];
      setPersonality(userId, p);
      await bot.sendMessage(chatId, `Стиль выбран: ${p}`);
      return;
    }

    if (data.startsWith("buy:")) {
      const id = data.split(":")[1];
      const pack = CREDIT_PACKS.find((p) => p.id === id);
      if (!pack) return;
      await sendStarsInvoice(chatId, userId, pack);
      return;
    }

    if (data.startsWith("vcancel:")) {
      const token = data.split(":")[1] || "";
      pendingVideoConfirm.delete(token);
      await bot.sendMessage(chatId, "Отменено.");
      return;
    }

    if (data.startsWith("vconf:")) {
      const token = data.split(":")[1] || "";
      const req = pendingVideoConfirm.get(token);
      if (!req || req.userId !== userId) {
        await bot.sendMessage(chatId, "Заявка устарела. Повтори /video.");
        return;
      }
      pendingVideoConfirm.delete(token);

      const { prompt, seconds, creditsNeeded } = req;
      const credits = getCredits(userId);
      if (credits.total < creditsNeeded) {
        await bot.sendMessage(chatId, `Не хватает кредитов. Нужно: ${creditsNeeded}, у тебя: ${credits.total}. /buy`);
        return;
      }

      const consumed = consumeVideoCredits(userId, creditsNeeded);
      if (!consumed.ok) {
        await bot.sendMessage(chatId, "Не удалось списать кредиты. /buy");
        return;
      }

      await bot.sendMessage(chatId, `Генерирую видео (Sora 2), ${seconds} сек...`);

      try {
        const buf = await generateVideoToBuffer({
          prompt,
          seconds: String(seconds),
          model: "sora-2",
        });

        const outPath = tmpFile(`sora_${chatId}_${Date.now()}.mp4`);
        fs.writeFileSync(outPath, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));

        // Send as document to avoid Telegram client duration glitches
        const fixed = await ffmpegFaststart(outPath).catch(() => outPath);
        const after = getCredits(userId);
        await bot.sendDocument(chatId, fixed, { caption: `Готово.\nБаланс: ${after.total}` });
      } catch (e) {
        console.log("Sora error:", e?.message || e);
        refundVideoCredits(userId, consumed.usedMonthly, consumed.usedPurchased);
        await bot.sendMessage(chatId, "Ошибка генерации. Кредиты возвращены.");
      }
      return;
    }
  } catch (e) {
    console.log("callback error:", e?.message || e);
  } finally {
    try {
      await bot.answerCallbackQuery(q.id);
    } catch {}
  }
});

// ------------------ PHOTO HANDLER (for /anim) ------------------

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const pending = awaitingAnimPhoto.get(userId);
  if (!pending) return;

  if (!DID_API_KEY) {
    awaitingAnimPhoto.delete(userId);
    await bot.sendMessage(chatId, "D-ID не настроен (нет DID_API_KEY).");
    return;
  }

  const credits = getCredits(userId);
  if (credits.total < DID_COST) {
    awaitingAnimPhoto.delete(userId);
    await bot.sendMessage(chatId, `Не хватает кредитов (нужно ${DID_COST}). /buy`);
    return;
  }

  const photo = (msg.photo || []).slice(-1)[0];
  if (!photo?.file_id) {
    awaitingAnimPhoto.delete(userId);
    await bot.sendMessage(chatId, "Не вижу фото. Пришли ещё раз.");
    return;
  }

  const consumed = consumeVideoCredits(userId, DID_COST);
  if (!consumed.ok) {
    awaitingAnimPhoto.delete(userId);
    await bot.sendMessage(chatId, "Не удалось списать кредиты. /buy");
    return;
  }

  awaitingAnimPhoto.delete(userId);

  await bot.sendMessage(chatId, "Генерирую анимацию (D-ID)...");

  try {
    const localPath = await downloadTelegramFile(
      bot,
      photo.file_id,
      tmpFile(`did_${chatId}_${Date.now()}.jpg`)
    );

    const sourceUrl = await didUploadImage(localPath);
    const talkId = await didCreateTalk({ sourceUrl, text: pending.text });
    const resultUrl = await didWaitForResult(talkId);

    const buf = await downloadToBuffer(resultUrl);
    const outPath = tmpFile(`did_out_${chatId}_${Date.now()}.mp4`);
    fs.writeFileSync(outPath, buf);

    // Fix mp4 metadata + send as document to preserve audio/duration in Telegram clients
    const fixed = await ffmpegFaststart(outPath).catch(() => outPath);

    const after = getCredits(userId);
    await bot.sendDocument(chatId, fixed, { caption: `Готово.\nБаланс: ${after.total}` });
  } catch (e) {
    console.log("D-ID error:", e?.message || e);
    refundVideoCredits(userId, consumed.usedMonthly, consumed.usedPurchased);
    await bot.sendMessage(chatId, "Ошибка D-ID. Кредиты возвращены.");
  }
});

// ------------------ CHAT (fallback) ------------------

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const text = msg.text || msg.caption || "";
  if (!text || text.startsWith("/")) return;
  if (msg.successful_payment) return;
  if (awaitingAnimPhoto.has(userId)) return;

  const user = getUser(userId);

  try {
    let useSearch = false;
    try {
      useSearch = await decideSearch(text);
    } catch {}

    let extra = "";
    if (useSearch) {
      try {
        const results = await webSearch(text);
        if (results) extra = `\n\n[web]\n${results}`;
      } catch {}
    }

    const history = getLastMessages(userId, 12);
    const answer = await chatOpenAI({
      user,
      text: text + extra,
      history,
    });

    addMessage(userId, "user", text);
    addMessage(userId, "assistant", answer);

    await bot.sendMessage(chatId, answer);
  } catch (e) {
    console.log("chat error:", e?.message || e);
    await bot.sendMessage(chatId, "Ошибка. Попробуй ещё раз.");
  }
});

// ------------------ BOOT ------------------

bot.getMe()
  .then((me) => console.log("Bot started:", me.username, me.id))
  .catch((e) => console.log("getMe error:", e?.message || e));

bot.on("polling_error", (e) => console.log("polling_error:", e?.message || e));
bot.on("webhook_error", (e) => console.log("webhook_error:", e?.message || e));
