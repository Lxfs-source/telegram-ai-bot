const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");

const openaiKey = process.env.OPENAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;

if (!openaiKey) console.warn("OPENAI_API_KEY is not set");
if (!geminiKey) console.warn("GEMINI_API_KEY is not set");

const openai = new OpenAI({ apiKey: openaiKey });
const genAI = geminiKey ? new GoogleGenerativeAI(geminiKey) : null;

// --- Chat (OpenAI по умолчанию) ---
async function chatOpenAI({ system, messages }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...messages,
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "…";
}

// --- STT (голос -> текст) ---
async function transcribeAudioMp3(mp3Path) {
  const file = fs.createReadStream(mp3Path);
  const resp = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
  });
  return (resp.text || "").trim();
}

// --- TTS (текст -> mp3) ---
async function ttsToMp3(text, outMp3Path) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    format: "mp3",
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outMp3Path, buf);
}

// --- OCR (картинка -> текст) через Gemini Vision ---
async function ocrWithGemini(imageBuffer) {
  if (!genAI) throw new Error("GEMINI_API_KEY not set");

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent([
    "Вытащи весь читаемый текст с изображения. Верни только текст, без комментариев.",
    {
      inlineData: {
        data: imageBuffer.toString("base64"),
        mimeType: "image/jpeg",
      },
    },
  ]);

  return (result.response.text() || "").trim();
}

// --- Image generation (OpenAI) ---
async function generateImage(prompt) {
  const resp = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
  });

  // URL может не вернуться в некоторых режимах, но обычно есть base64 или url.
  const item = resp.data?.[0];
  if (item?.url) return { type: "url", value: item.url };
  if (item?.b64_json) return { type: "b64", value: item.b64_json };
  throw new Error("No image returned");
}

// --- Video generation (Sora) ---
// seconds must be one of: "4" | "8" | "12"
async function generateVideoToBuffer({ prompt, seconds = "4", model = "sora-2" }) {
  // create + poll
  const video = await openai.videos.createAndPoll({
    model,
    prompt,
    seconds: String(seconds),
    size: "1280x720",
  });

  if (video.status !== "completed") {
    const msg = video?.error?.message || `Video generation failed. Status: ${video.status}`;
    throw new Error(msg);
  }

  const content = await openai.videos.downloadContent(video.id);
  const buf = Buffer.from(await content.arrayBuffer());
  return { videoId: video.id, buffer: buf };
}

module.exports = {
  chatOpenAI,
  transcribeAudioMp3,
  ttsToMp3,
  ocrWithGemini,
  generateImage,
  generateVideoToBuffer,
  decideSearch,
};
async function decideSearch({ userText }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Ты маршрутизатор. Определи, нужен ли веб-поиск, чтобы ответить актуально/точно. " +
          "Если нужен — сформируй короткий поисковый запрос. " +
          'Верни СТРОГО JSON без пояснений: {"search": true/false, "query": "строка"}',
      },
      { role: "user", content: userText },
    ],
  });

  const txt = resp.choices?.[0]?.message?.content?.trim() || "";
  try {
    const obj = JSON.parse(txt);
    return {
      search: Boolean(obj.search),
      query: typeof obj.query === "string" ? obj.query : userText,
    };
  } catch {
    return { search: false, query: "" };
  }
}