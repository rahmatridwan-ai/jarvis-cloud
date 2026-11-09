/**
 * JARVIS CLOUD — AI Telegram via GitHub Actions
 * Pola sama dengan Kripto Pantau: cron GitHub membangkitkan bot
 * sesekali -> bot long-polling beberapa menit -> jawab -> commit state.
 *
 * Tanpa dependensi (https bawaan node). Tanpa PC. Tanpa kartu kredit.
 *
 * Fitur v1:
 *  - Ketik apa saja  -> dijawab GLM-4.5-Flash (Z.AI gratis)
 *  - /gambar <teks>  -> gambar AI Pollinations (gratis, tanpa key)
 *  - /status         -> info siklus terakhir
 *  - hanya owner (chat id) yang dilayani
 */

const https = require("https")
const fs = require("fs")
const path = require("path")

const ROOT = __dirname
const STATE_FILE = path.join(ROOT, "state.json")

const TOKEN = process.env.TELEGRAM_TOKEN || ""
const OWNER = String(process.env.TELEGRAM_CHAT_ID || "")
const ZAI_KEY = process.env.ZAI_API_KEY || ""
const ZAI_MODEL = process.env.ZAI_MODEL || "glm-4.5-flash"
const MAX_MS = Number(process.env.CYCLE_MS || 240000) // default 4 menit polling per siklus

if (!TOKEN || !OWNER || !ZAI_KEY) {
  console.error("ENV kurang (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID / ZAI_API_KEY)")
  process.exit(1)
}

// ---------------------------------------------------------------- util http
function httpJson(metode, host, jalur, headers, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null
    const req = https.request(
      { hostname: host, path: jalur, method: metode || "GET",
        headers: Object.assign({}, headers || {},
          data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      r => {
        let b = ""
        r.on("data", c => b += c)
        r.on("end", () => {
          try { res(JSON.parse(b)) } catch (e) { rej(new Error(`HTTP ${r.statusCode} parse: ${b.slice(0, 120)}`)) }
        })
      })
    req.on("error", rej)
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.setTimeout(0)
    if (data) req.write(data)
    req.end()
  })
}

const TG = (m, p) => httpJson("POST", "api.telegram.org", `/bot${TOKEN}/${m}`, {}, p)
const tgAPI = (m, p, timeout) => new Promise((res, rej) => {
  const data = JSON.stringify(p || {})
  const req = https.request({
    hostname: "api.telegram.org", path: `/bot${TOKEN}/${m}`, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
  }, r => {
    let b = ""
    r.on("data", c => b += c)
    r.on("end", () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  })
  req.on("error", rej)
  req.setTimeout(timeout || 40000, () => req.destroy(new Error("timeout API")))
  req.write(data); req.end()
})

// ---------------------------------------------------------------- state
function muatState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch { return { offset: 0, terakhir: "" } }
}
function simpanState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }
let state = muatState()

// ---------------------------------------------------------------- kirim teks
async function kirim(chatId, teks) {
  const batas = 3800
  for (let i = 0; i < teks.length; i += batas) {
    await tgAPI("sendMessage", { chat_id: chatId, text: teks.slice(i, i + batas) },
      30000).catch(async e => {
        // fallback: kirim tanpa mode apa pun
        await tgAPI("sendMessage", { chat_id: chatId, text: teks.slice(i, i + batas).slice(0, 3800) })
      })
  }
}

// ---------------------------------------------------------------- GLM (Z.AI)
async function tanyaGLM(pertanyaan) {
  const r = await httpJson("POST", "api.z.ai", "/api/paas/v4/chat/completions", {
    Authorization: `Bearer ${ZAI_KEY}`,
  }, {
    model: ZAI_MODEL,
    max_tokens: 1500,
    messages: [
      { role: "system", content:
        "Kamu JARVIS, asisten AI pribadi Berbahasa Indonesia yang ramah dan singkat. " +
        "Jawab padat langsung ke intinya, maksimal 2-3 paragraf. Tidak bisa browsing atau membuka file." },
      { role: "user", content: pertanyaan.slice(0, 6000) },
    ],
  })
  if (r.error) throw new Error(r.error.message || JSON.stringify(r.error))
  const t = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content
  return (t || "").trim() || "(jawaban kosong)"
}
const tanyaGLMapi = (p) => tanyaGLM(p)

// ---------------------------------------------------------------- gambar
function unduhBinary(url, timeout) {
  return new Promise((res, rej) => {
    const ambil = u => {
      const req = https.get(u, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume(); return ambil(r.headers.location)
        }
        if (r.statusCode !== 200) { r.resume(); return rej(new Error("HTTP " + r.statusCode)) }
        const c = []; r.on("data", d => c.push(d))
        r.on("end", () => res(Buffer.concat(c)))
      })
      req.on("error", rej)
      req.setTimeout(timeout || 90000, () => req.destroy(new Error("timeout unduh")))
    }
    ambil(url)
  })
}

async function kirimFoto(chatId, buf, caption) {
  const boundary = "----JARVIS" + Date.now()
  const kepala = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption || "").slice(0, 800)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="jarvis.jpg"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`)
  const isi = Buffer.concat([kepala, buf, Buffer.from(`\r\n--${boundary}--\r\n`)])
  await new Promise((res, rej) => {
    const req = https.request({
      hostname: "api.telegram.org", path: `/bot${TOKEN}/sendPhoto`, method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": isi.length },
    }, r => { r.resume(); r.on("end", res) })
    req.on("error", rej)
    req.write(isi); req.end()
  })
}

const MENU =
  "🤖 JARVIS CLOUD (GitHub 24 jam)\n\n" +
  "• Ketik apa saja → dijawab AI (GLM-4.5 Flash)\n" +
  "• /gambar <deskripsi> → gambar AI\n" +
  "• /status → kondisi bot\n\n" +
  "Catatan: bot bangun tiap ±5 menit, jawaban bisa 1–10 menit. " +
  "Tidak punya akses file PC (versi cloud)."

let ubahState = false

// ---------------------------------------------------------------- proses pesan
async function proses(msg) {
  const chatId = msg.chat && msg.chat.id
  if (String(chatId) !== OWNER) return // bukan owner: diam
  const teks = (msg.text || "").trim()
  if (!teks) return
  console.log("perintah:", teks.slice(0, 80))

  if (teks === "/start" || teks === "/menu" || teks === "/bantuan") return kirim(chatId, MENU)

  if (teks === "/status") {
    return kirim(chatId,
      `✅ Bot hidup\nJam UTC : ${new Date().toUTCString()}\nOffset  : ${state.offset}\nSiklus  : diluncurkan otomatis GitHub tiap ±5 menit`)
  }

  if (teks.startsWith("/gambar ")) {
    const prompt = teks.slice(8).trim().slice(0, 500)
    await kirim(chatId, `🎨 Membuat gambar: ${prompt} (tunggu 10–40 detik)`)
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now() % 1000000}`
      const buf = await unduhBinary(url)
      if (!buf || buf.length < 2000) throw new Error("gambar terlalu kecil")
      return await kirimFoto(chatId, buf, prompt)
    } catch (e) {
      return kirim(chatId, "❌ Server gambar gagal, coba lagi sebentar.")
    }
  }
  if (teks === "/gambar") return kirim(chatId, "Pakai: /gambar kucing astronot")

  // default: tanya AI
  try {
    const jawab = await tanyaGLMapi(teks)
    return await kirim(chatId, jawab)
  } catch (e) {
    return await kirim(chatId, `❌ Gagal menjawab: ${e.message}\nCoba lagi sebentar.`)
  }
}

// ---------------------------------------------------------------- siklus utama
async function main() {
  // hapus webhook biar getUpdates jalan
  await tgAPI("deleteWebhook", { drop_pending_updates: false }).catch(() => {})

  const mulai = Date.now()
  console.log(`JARVIS CLOUD masuk siklus ${Math.round(MAX_MS / 1000)} detik...`)
  state.terakhir = new Date().toISOString()
  ubahState = true

  while (Date.now() - mulai < MAX_MS) {
    let r
    try {
      r = await tgAPI("getUpdates", {
        offset: state.offset, timeout: 25,
        allowed_updates: ["message"],
      }, 35000)
    } catch (e) {
      console.log("poll error:", e.message)
      await new Promise(x => setTimeout(x, 5000))
      continue
    }
    if (r.ok === false) { await new Promise(x => setTimeout(x, 5000)); continue }

    for (const u of r.result || []) {
      state.offset = u.update_id + 1
      ubahState = true
      simpanState(state) // simpan segera biar tidak dobel jawab kalau di-cancel
      if (u.message) await proses(u.message).catch(e => console.log("err proses:", e.message))
    }
  }

  simpanState(state)
  console.log(`Siklus selesai (${Math.round((Date.now() - mulai) / 1000)}s), offset=${state.offset}`)
}

main().catch(e => { console.error("FATAL:", e); process.exit(1) })
