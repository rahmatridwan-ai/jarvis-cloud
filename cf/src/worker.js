/**
 * JARVIS INSTANT — Cloudflare Worker (v2)
 * - POST /webhook : diterima Telegram SAAT PESAN TIBA (instan, bukan cron!)
 * - GET  /        : PWA chat (bisa di-install di HP sebagai "app")
 * - GET  /health
 *
 * Fitur v2:
 *   • /edit      → kirim FOTO + caption "/edit <instruksi>" → Gemini edit gambar
 *   • /gambar    → Pollinations, fallback Gemini image
 *   • /video     → info: video penuh via bot PC (FFmpeg), cloud = naskah/ide
 *   • Chat teks  → GLM-4.5-flash; kalau limit (1305/429) fallback Gemini-2.5-flash
 *
 * Secrets (wrangler secret put): TG_TOKEN, CHAT_ID, ZAI_KEY, CHATKEY, GEM_KEY
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === "POST" && path === "/webhook") {
      const update = await request.json()
      // jawab dulu ke Telegram agar tidak retry, proses di belakang
      ctx.waitUntil(prosesUpdate(update, env))
      return new Response("ok")
    }

    if (request.method === "GET" && path === "/health") return new Response("JARVIS instant hidup")

    if (path === "/" || path === "/chat") return halamanPWA()
    if (path === "/manifest.json") return manifest()
    if (path === "/sw.js") return serviceWorker()
    if (path === "/icon.svg") return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml" } })

    if (request.method === "POST" && path === "/api/tanya") {
      // dipakai PWA: butuh ?k=CHATKEY
      if (!env.CHATKEY || url.searchParams.get("k") !== env.CHATKEY) return new Response("forbidden", { status: 403 })
      const { teks } = await request.json().catch(() => ({}))
      if (!teks) return new Response("teks kosong", { status: 400 })
      let jawab
      try { jawab = await tanyaJawab(teks, env) }
      catch (e) { return new Response(`❌ ${String(e.message).slice(0, 200)}`, { status: 502 }) }
      return new Response(jawab, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    }

    return new Response("not found", { status: 404 })
  },
}

// ---------------------------------------------------------------- GLM
async function tanyaGLM(teks, env, maxTokens = 1500) {
  const r = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-4.5-flash",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content:
          "Kamu JARVIS, asisten AI berbahasa Indonesia yang ramah dan singkat. " +
          "Jawab padat langsung ke inti, maksimal 2-3 paragraf. Tidak bisa browsing." },
        { role: "user", content: String(teks).slice(0, 6000) },
      ],
    }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
  return j.choices?.[0]?.message?.content?.trim() || "(jawaban kosong)"
}

// ---------------------------------------------------------------- Gemini (fallback + gambar)
const GEM_BASE = "https://generativelanguage.googleapis.com/v1beta"

// tanyaGLM dulu; kalau Z.AI kena limit/overloaded, jawab pakai Gemini text
async function tanyaJawab(teks, env) {
  try {
    return await tanyaGLM(teks, env)
  } catch (e) {
    const pesan = String(e?.message || e)
    const kenaLimit = /1305|429|insufficient|balance|limit|overloaded|999|too many/i.test(pesan)
    console.log("GLM gagal:", pesan.slice(0, 120), kenaLimit ? "-> fallback Gemini" : "")
    if (kenaLimit && env.GEM_KEY) {
      try {
        return await geminiTeks(env, teks)
      } catch (e2) {
        throw new Error(`GLM limit & Gemini gagal: ${String(e2.message).slice(0, 120)}`)
      }
    }
    throw e
  }
}

async function geminiTeks(env, teks) {
  const r = await fetch(`${GEM_BASE}/models/gemini-2.5-flash:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEM_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        "Kamu JARVIS, asisten AI berbahasa Indonesia yang ramah dan singkat. " +
        "Jawab padat langsung ke inti, maksimal 2-3 paragraf." }] },
      contents: [{ role: "user", parts: [{ text: String(teks).slice(0, 6000) }] }],
      generationConfig: { maxOutputTokens: 1200 },
    }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
  const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim()
  return t || "(jawaban kosong)"
}

// generate / edit gambar via Gemini image model
async function geminiGambar(env, parts) {
  const model = env.GEM_IMAGE || "gemini-2.5-flash-image"
  const r = await fetch(`${GEM_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEM_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }] }),
  })
  const j = await r.json()
  const img = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)
  if (!img) {
    const ket = JSON.stringify(j.error || j.promptFeedback || "no image part").slice(0, 180)
    throw new Error("Gemini tidak hasilkan gambar: " + ket)
  }
  return { mime: img.inlineData.mimeType || "image/png", data: img.inlineData.data }
}

function toB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// buat gambar via Cloudflare Workers AI (gratis, dalam akun sendiri)
async function gambarWorkersAI(env, prompt) {
  const r = await env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt: String(prompt) })
  let buf = null
  if (r instanceof ArrayBuffer) buf = r
  else if (r instanceof ReadableStream) buf = await new Response(r).arrayBuffer()
  else if (r instanceof Response) buf = await r.arrayBuffer()
  else if (r && typeof r.arrayBuffer === "function") buf = await r.arrayBuffer()
  else if (r?.image) return { mime: "image/jpeg", data: r.image } // flux mengembalikan JSON base64
  if (!buf || buf.byteLength < 500) throw new Error("Workers AI tidak hasilkan gambar")
  return { buf, mime: "image/png" }
}

// kirim hasil gambar Workers AI (ArrayBuffer) sebagai foto
async function kirimBuf(env, chatId, buf, caption) {
  const fd = new FormData()
  fd.append("chat_id", String(chatId))
  if (caption) fd.append("caption", caption.slice(0, 800))
  fd.append("photo", new Blob([buf], { type: "image/png" }), "jarvis.png")
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendPhoto`, { method: "POST", body: fd })
  if (!r.ok) throw new Error("sendPhoto gagal: " + (await r.text()).slice(0, 150))
}

// ---------------------------------------------------------------- Telegram helpers
const tgSend = (tok, method, payload) =>
  fetch(`https://api.telegram.org/bot${tok}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

async function kirimTeks(env, chatId, teks) {
  const batas = 3800
  for (let i = 0; i < Math.min(teks.length, 12000); i += batas) {
    await tgSend(env.TG_TOKEN, "sendMessage", { chat_id: chatId, text: teks.slice(i, i + batas) })
  }
}

async function kirimFoto(env, chatId, urlGambar, caption) {
  const tgSendForm = (payload) => {
    const fd = new FormData()
    fd.append("chat_id", String(chatId))
    if (caption) fd.append("caption", caption.slice(0, 800))
    fd.append("photo", payload)
    return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendPhoto`, { method: "POST", body: fd })
  }
  const r = await fetch(urlGambar)
  if (!r.ok) throw new Error("gambar gagal " + r.status)
  return tgSendForm(await r.blob())
}

// kirim hasil gambar Gemini (base64) sebagai foto
async function kirimBiner(env, chatId, { mime, data }, caption) {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const fd = new FormData()
  fd.append("chat_id", String(chatId))
  if (caption) fd.append("caption", caption.slice(0, 800))
  fd.append("photo", new Blob([bytes], { type: mime }), "jarvis.png")
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendPhoto`, { method: "POST", body: fd })
  if (!r.ok) throw new Error("sendPhoto gagal: " + (await r.text()).slice(0, 150))
}

// edit foto owner: fetch file dari Telegram, kirim ke Gemini, balas hasilnya
async function editFoto(env, chatId, photoArr, instruksi) {
  await kirimTeks(env, chatId, `🖌️ Mengedit foto: ${instruksi.slice(0, 120)}\n(mohon tunggu ±20-40 detik)`)
  const fileId = photoArr[photoArr.length - 1].file_id // ukuran terbesar
  const info = await (await tgSend(env.TG_TOKEN, "getFile", { file_id: fileId })).json()
  const path = info?.result?.file_path
  if (!path) throw new Error("getFile gagal: " + JSON.stringify(info).slice(0, 120))
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}`)
  if (!r.ok) throw new Error("unduh foto gagal " + r.status)
  const b64 = toB64(await r.arrayBuffer())
  const out = await geminiGambar(env, [
    { inlineData: { mimeType: "image/jpeg", data: b64 } },
    { text: `Edit foto ini sesuai permintaan: ${instruksi}. Pertahankan wajah dan identitas orang di foto bila ada. Hasil akhirnya berupa gambar yang sudah diedit.` },
  ])
  await kirimBiner(env, chatId, out, `✅ Hasil edit: ${instruksi.slice(0, 200)}`)
}

// ---------------------------------------------------------------- proses update
async function prosesUpdate(update, env) {
  const msg = update.message
  if (!msg) return
  const chatId = msg.chat?.id
  if (!chatId || String(chatId) !== String(env.CHAT_ID)) return // hanya owner
  const teks = (msg.text || (msg.caption || "")).trim()
  console.log("perintah:", teks.slice(0, 80) || "(foto tanpa caption)")

  try {
    // --- FOTO: edit via caption /edit
    if (msg.photo?.length) {
      if (!teks)
        return await kirimTeks(env, chatId,
          "📸 Foto diterima! Untuk mengedit, kirim ulang foto itu dengan caption:\n" +
          "/edit ubah langit jadi malam penuh bintang")
      if (/^\/edit(foto)?\b/.test(teks)) {
        const instruksi = teks.replace(/^\/edit(foto)?\s*/, "").trim()
        if (!instruksi)
          return await kirimTeks(env, chatId, "Tulis instruksi edit di caption, contoh: /edit ubah jadi hitam putih")
        await editFoto(env, chatId, msg.photo, instruksi).catch(async e => {
          const m = String(e.message || e)
          console.log("edit gagal:", m.slice(0, 160))
          if (/429|quota|exceeded|RESOURCE/i.test(m))
            await kirimTeks(env, chatId,
              "⏳ Kuota edit foto gratisan sedang habis (kuota AI harian).\n" +
              "Biasanya terbuka lagi antara 1–6 jam — coba ulang nanti ya.\n\n" +
              "💡 Opsi cepat lain:\n" +
              "• Edit dasar (b&w, sepia, cerah, crop) → /video menu di bot PC @darksystemjarvis_bot (FFmpeg, PC nyala)\n" +
              "• Sementara: AI Studio web https://aistudio.google.com (login Google, gratis di browser)")
          else
            await kirimTeks(env, chatId, "❌ Edit gagal: " + m.slice(0, 200))
        })
        return
      }
      return await kirimTeks(env, chatId, "📸 Foto diterima. Balas foto itu dengan caption /edit <instruksi> supaya saya edit.")
    }

    if (!teks) return

    if (teks === "/start" || teks === "/menu" || teks === "/bantuan")
      return await kirimTeks(env, chatId,
        "⚡ JARVIS INSTANT v2 (Cloudflare 24 jam)\n\n" +
        "• Ketik apa saja → dijawab SEGERA (detik, bukan menit)\n" +
        "• /gambar <deskripsi> → buat gambar AI baru\n" +
        "• FOTO + caption /edit <instruksi> → edit foto kamu\n" +
        "• /video → cara bikin video konten\n" +
        "• /status → kondisi bot\n" +
        "• PWA: buka URL worker ini di HP → 'Add to Home Screen'")

    if (teks === "/status")
      return await kirimTeks(env, chatId, `✅ Bot instant v2 hidup\nJam UTC: ${new Date().toUTCString()}\nFitur: chat / gambar / EDIT FOTO\nTerima pesan: INSTAN (webhook)`)

    if (teks === "/video" || teks.startsWith("/video "))
      return await kirimTeks(env, chatId,
        "🎬 Soal VIDEO konten:\n\n" +
        "Generator video AI gratisan di cloud belum tersedia (Veo/Sora hanya berbayar) — jadi video PENUH hanya bisa lewat bot PC: \n" +
        "→ @darksystemjarvis_bot → /video <ide>  (PC harus nyala, mesin FFmpeg)\n\n" +
        "Sedangkan saya (cloud, PC mati pun) bisa:\n" +
        "• Bikin NASKAH/naskah+storyboard video kamu → ketik: \"buat naskah video 30 detik tentang ...\"\n" +
        "• Bikin thumbnail/pending gambar via /gambar\n\n" +
        "Mau saya buatkan naskahnya sekarang? ")

    if (teks === "/gambar")
      return await kirimTeks(env, chatId, "Pakai: /gambar kucing astronot")

    if (teks.startsWith("/gambar ")) {
      const prompt = teks.slice(8).trim().slice(0, 500)
      await kirimTeks(env, chatId, `🎨 Membuat gambar: ${prompt}`)
      let ok = false
      // 1) Pollinations (paling cepat)
      try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now() % 1000000}`
        await kirimFoto(env, chatId, url, prompt)
        ok = true
      } catch (e) { console.log("pollinations gagal:", String(e.message).slice(0, 100)) }
      // 2) Workers AI SDXL (hidup dalam akun Cloudflare sendiri) — jika Pollinations gagal
      if (!ok && env.AI) {
        try {
          const out = await gambarWorkersAI(env, prompt)
          if (out.buf) await kirimBuf(env, chatId, out.buf, prompt)
          else await kirimBiner(env, chatId, out, prompt)
          ok = true
        } catch (e) { console.log("workers-ai gagal:", String(e.message).slice(0, 100)) }
      }
      // 3) Gemini image
      if (!ok && env.GEM_KEY) {
        try {
          const out = await geminiGambar(env, [{ text: `Buat gambar: ${prompt}` }])
          await kirimBiner(env, chatId, out, prompt)
          ok = true
        } catch (e) { console.log("gemini gambar gagal:", String(e.message).slice(0, 100)) }
      }
      if (!ok) await kirimTeks(env, chatId, "❌ Semua server gambar sedang sibuk/limit. Coba lagi 1-2 menit lagi ya.")
      return
    }

    const jawab = await tanyaJawab(teks, env)
    await kirimTeks(env, chatId, jawab)
  } catch (e) {
    console.log("gagal proses:", String(e?.message || e).slice(0, 200))
    await kirimTeks(env, chatId, `❌ Gagal: ${String(e.message).slice(0, 300)}`)
  }
}

// ---------------------------------------------------------------- PWA (chat web, bisa di-install di HP)
function manifest() {
  return new Response(JSON.stringify({
    name: "JARVIS Cloud", short_name: "JARVIS",
    start_url: "/", display: "standalone", background_color: "#0b0e14", theme_color: "#0b0e14",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  }), { headers: { "Content-Type": "application/json" } })
}

function serviceWorker() {
  return new Response(`self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => self.clients.claim());
self.addEventListener("fetch", e => {});`,
    { headers: { "Content-Type": "application/javascript" } })
}

const PWA_HTML = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS Cloud</title>
<meta name="theme-color" content="#0b0e14">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
 body{margin:0;font-family:system-ui;background:#0b0e14;color:#e6e6e6;height:100dvh;display:flex;flex-direction:column}
 header{padding:12px;background:#131826;font-weight:600}
 #log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
 .me{align-self:flex-end;background:#2563eb;color:#fff;padding:8px 12px;border-radius:14px 14px 2px 14px;max-width:80%}
 .ai{align-self:flex-start;background:#1c2333;padding:8px 12px;border-radius:14px 14px 14px 2px;max-width:86%;white-space:pre-wrap}
 form{display:flex;gap:8px;padding:10px;background:#131826}
 input{flex:1;padding:10px 12px;border-radius:10px;border:0;background:#222a3d;color:#fff}
 button{padding:10px 16px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600}
 #kunci{width:100%;padding:12px;background:#0b0e14;display:flex;gap:8px}
</style></head>
<body>
<header>JARVIS Cloud ⚡ (instant)</header>
<div id="pesan" style="padding:8px 12px;background:#111827;color:#9ca3af;font-size:13px"></div>
<div id="kunci"><input id="k" placeholder="Kunci khusus kamu (CHATKEY)"><button id="buka">Buka</button></div>
<div id="log"></div>
<form id="f"><input id="i" placeholder="Tulis pertanyaan..." autocomplete="off"><button>Kirim</button></form>
<script>
const log = document.getElementById("log"), f = document.getElementById("f"), i = document.getElementById("i")
const pesan = document.getElementById("pesan")
let K = localStorage.kunci || ""
if (K) { document.getElementById("kunci").style.display = "none"; pesan.textContent = "Terhubung. Ketik di bawah." }
document.getElementById("buka").onclick = () => { K = document.getElementById("k").value.trim(); localStorage.kunci = K; location.reload() }
function tambah(cls, t) { const d = document.createElement("div"); d.className = cls; d.textContent = t; log.appendChild(d); log.scrollTop = log.scrollHeight; return d }
f.onsubmit = async e => {
  e.preventDefault()
  const t = i.value.trim(); if (!t || !K) return
  tambah("me", t); i.value = ""
  const W = tambah("ai", "…sedang menjawab…")
  try {
    const r = await fetch("/api/tanya?k=" + encodeURIComponent(K), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teks: t }) })
    if (r.status === 403) { W.textContent = "❌ Kunci salah. Refresh halaman untuk isi kunci lagi."; localStorage.removeItem("kunci"); }
    else { const jt = await r.text(); W.textContent = jt || "(kosong)" }
  } catch (err) { W.textContent = "❌ " + err.message }
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js")
</script>
</body></html>`

function halamanPWA() { return new Response(PWA_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }) }

// icon svg (dipakai manifest & apple touch icon)
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#131826"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#2563eb" font-family="system-ui, sans-serif" font-weight="700">J</text></svg>'
