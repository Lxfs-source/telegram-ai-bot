const fs = require("fs");
const path = require("path");

async function downloadTelegramFile(bot, fileId, outPath) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed download: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

module.exports = { downloadTelegramFile };