/**
 * JARVIS INSTANT — Cloudflare Worker (v1)
 * - POST /webhook : diterima Telegram SAAT PESAN TIBA (instal, bukan cron!)
 * - GET  /        : PWA chat (bisa di-install di HP sebagai "app")
 * - GET  /health
 *
 * Secrets (wrangler secret put): TG_TOKEN, CHAT_ID, ZAI_KEY, CHATKEY
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
      const jawab = await tanyaGLM(teks, env)
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

// ---------------------------------------------------------------- proses update
async function prosesUpdate(update, env) {
  const msg = update.message
  if (!msg) return
  const chatId = msg.chat?.id
  if (!chatId || String(chatId) !== String(env.CHAT_ID)) return // hanya owner
  const teks = (msg.text || "").trim()
  if (!teks) return
  console.log("perintah:", teks.slice(0, 80))

  try {
    if (teks === "/start" || teks === "/menu" || teks === "/bantuan")
      return await kirimTeks(env, chatId,
        "⚡ JARVIS INSTANT (Cloudflare 24 jam)\n\n" +
        "• Ketik apa saja → dijawab SEGERA (detik, bukan menit)\n" +
        "• /gambar <deskripsi> → gambar AI\n" +
        "• PWA: buka URL worker ini di HP → 'Add to Home Screen'")

    if (teks === "/status")
      return await kirimTeks(env, chatId, `✅ Bot instant hidup\nJam UTC: ${new Date().toUTCString()}\nTerima pesan: INSTAN (webhook)`)

    if (teks === "/gambar")
      return await kirimTeks(env, chatId, "Pakai: /gambar kucing astronot")

    if (teks.startsWith("/gambar ")) {
      const prompt = teks.slice(8).trim().slice(0, 500)
      await kirimTeks(env, chatId, `🎨 Membuat gambar: ${prompt}`)
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now() % 1000000}`
      try {
        await kirimFoto(env, chatId, url, prompt)
      } catch (e) {
        await kirimTeks(env, chatId, "❌ Server gambar gagal" + e.message)
      }
      return
    }

    const jawab = await tanyaGLM(teks, env)
    await kirimTeks(env, chatId, jawab)
  } catch (e) {
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
