/**
 * JARVIS INSTANT — Cloudflare Worker (v3)
 * - POST /webhook : diterima Telegram SAAT PESAN TIBA (instan, bukan cron!)
 * - GET  /        : PWA chat (bisa di-install di HP sebagai "app")
 * - GET  /health
 *
 * Fitur v3:
 *   • Chat + MEMORY (KV) — ingat konteks percakapan, /reset hapus
 *   • /pikir on|off — GLM reasoning (berpikir dulu, lebih akurat)
 *   • FOTO + caption <instruksi> → edit gambar (FLUX Kontext → Gemini)
 *   • FOTO + caption /lihat → vision: baca & jelaskan foto (LLaVA)
 *   • File .txt/.md/.csv → JARVIS baca dokumen
 *   • /storyboard <ide> → naskah video + gambar tiap adegan
 *   • /gambar → Pollinations → Workers AI SDXL → Gemini
 *   • /search → Pollinations text
 *   • /monitor, /status, /video
 *
 * Secrets: TG_TOKEN, CHAT_ID, ZAI_KEY, CHATKEY, GEM_KEY
 * Bindings: AI (Workers AI), MEM (KV namespace)
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
      try { jawab = await tanyaJawab(teks, env, "pwa") }
      catch (e) { return new Response(`❌ ${String(e.message).slice(0, 200)}`, { status: 502 }) }
      return new Response(jawab, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    }

    return new Response("not found", { status: 404 })
  },
}

// ---------------------------------------------------------------- Memory (KV — ingatan percakapan)
async function memGet(env, chatId) {
  if (!env.MEM) return []
  try { const v = await env.MEM.get(`chat:${chatId}`); return v ? JSON.parse(v) : [] } catch { return [] }
}
async function memSave(env, chatId, hist) {
  if (!env.MEM) return
  try { await env.MEM.put(`chat:${chatId}`, JSON.stringify(hist.slice(-20))) } catch {}
}
async function cfgGet(env, chatId) {
  if (!env.MEM) return { pikir: false }
  try { const v = await env.MEM.get(`cfg:${chatId}`); return v ? JSON.parse(v) : { pikir: false } } catch { return { pikir: false } }
}
async function cfgSet(env, chatId, cfg) {
  if (!env.MEM) return
  try { await env.MEM.put(`cfg:${chatId}`, JSON.stringify(cfg)) } catch {}
}

// ---------------------------------------------------------------- GLM (dengan riwayat + mode pikir)
async function glmChat(env, messages, pikir) {
  const body = { model: "glm-4.5-flash", max_tokens: pikir ? 3000 : 1500, messages }
  if (pikir) body.thinking = { type: "enabled" } // GLM reasoning — berpikir dulu sebelum jawab
  const r = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
  const m = j.choices?.[0]?.message
  return (m?.content?.trim()) || (m?.reasoning_content?.trim()) || "(jawaban kosong)"
}

// ---------------------------------------------------------------- Gemini (fallback + gambar)
const GEM_BASE = "https://generativelanguage.googleapis.com/v1beta"

// otak utama: ingat konteks + fallback Gemini saat limit
async function tanyaJawab(teks, env, chatId = null) {
  const hist = chatId ? await memGet(env, chatId) : []
  const cfg = chatId ? await cfgGet(env, chatId) : { pikir: false }
  const pesanUser = { role: "user", content: String(teks).slice(0, 6000) }
  const messages = [
    { role: "system", content:
      "Kamu JARVIS, asisten AI berbahasa Indonesia yang ramah dan singkat. " +
      "Kamu ingat isi percakapan sebelumnya dan merujuknya bila relevan. " +
      "Jawab padat langsung ke inti, maksimal 2-3 paragraf." },
    ...hist,
    pesanUser,
  ]
  let isi = null
  try {
    isi = await glmChat(env, messages, cfg.pikir)
  } catch (e) {
    const pesan = String(e?.message || e)
    const kenaLimit = /1305|429|insufficient|balance|limit|overloaded|999|too many/i.test(pesan)
    console.log("GLM gagal:", pesan.slice(0, 120), kenaLimit ? "-> fallback Gemini" : "")
    if (kenaLimit && env.GEM_KEY) {
      try { isi = await geminiTeks(env, teks) }
      catch (e2) { throw new Error(`GLM limit & Gemini gagal: ${String(e2.message).slice(0, 120)}`) }
    } else throw e
  }
  if (chatId) {
    hist.push(pesanUser, { role: "assistant", content: isi })
    await memSave(env, chatId, hist)
  }
  return isi
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

// edit foto owner: fetch file dari Telegram, edit via FLUX Kontext (HF Space, gratis),
// cadangan Gemini; balas hasilnya
async function editFoto(env, chatId, photoArr, instruksi) {
  await kirimTeks(env, chatId, `🖌️ Mengedit foto: ${instruksi.slice(0, 120)}\n(mohon tunggu ±30-90 detik)`)
  const fileId = photoArr[photoArr.length - 1].file_id // ukuran terbesar
  const info = await (await tgSend(env.TG_TOKEN, "getFile", { file_id: fileId })).json()
  const path = info?.result?.file_path
  if (!path) throw new Error("getFile gagal: " + JSON.stringify(info).slice(0, 120))
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}`)
  if (!r.ok) throw new Error("unduh foto gagal " + r.status)
  const fotoBuf = await r.arrayBuffer()

  // 1) FLUX Kontext via Hugging Face Space (gratis, tanpa kunci)
  try {
    const promptEn = await terjemahkan(instruksi, env)
    const url = await editFlux(env, fotoBuf, promptEn)
    return await kirimFoto(env, chatId, url, `✅ Hasil edit: ${instruksi.slice(0, 200)}`)
  } catch (e) {
    console.log("flux kontext gagal:", String(e.message || e).slice(0, 150))
  }

  // 2) gemini image (kadang kuotanya terbuka)
  if (env.GEM_KEY) {
    try {
      const out = await geminiGambar(env, [
        { inlineData: { mimeType: "image/jpeg", data: toB64(fotoBuf) } },
        { text: `Edit foto ini: ${instruksi}. Pertahankan wajah/identitas orang di foto.` },
      ])
      return await kirimBiner(env, chatId, out, `✅ Hasil edit: ${instruksi.slice(0, 200)}`)
    } catch (e) {
      console.log("gemini edit gagal:", String(e.message || e).slice(0, 150))
    }
  }

  throw new Error("Server edit sedang sibuk/limit — coba lagi beberapa menit lagi ya")
}

// terjemahkan instruksi Indonesia -> prompt Inggris ringkas (GLM), gagal = pakai asli
async function terjemahkan(teks, env) {
  try {
    const r = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ZAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.5-flash", max_tokens: 200,
        messages: [{ role: "user", content:
          `Terjemahkan instruksi edit foto berikut ke Bahasa Inggris ringkas untuk prompt edit gambar. Jawab HANYA terjemahannya: ${String(teks).slice(0, 300)}` }],
      }),
    })
    const j = await r.json()
    const t = j.choices?.[0]?.message?.content?.trim()
    return (t && t.length > 2) ? t : teks
  } catch { return teks }
}

// baca stream SSE sampai event complete/error
async function sseFinal(r) {
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = "", ev = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith("event:")) ev = t.slice(6).trim()
      else if (t.startsWith("data:") && ev) {
        const data = t.slice(5).trim()
        if (ev === "complete") return { ok: true, data }
        if (ev === "error") return { ok: false, err: data }
      }
    }
  }
  return { ok: false, err: "stream berakhir tanpa hasil" }
}

// edit gambar via FLUX.1-Kontext (Hugging Face Space publik, anonim)
async function editFlux(env, fotoBuf, instruksiEn) {
  const space = env.FLUX_SPACE || "https://black-forest-labs-flux-1-kontext-dev.hf.space"
  // upload
  const fd = new FormData()
  fd.append("files", new Blob([fotoBuf], { type: "image/jpeg" }), "foto.jpg")
  const up = await fetch(`${space}/gradio_api/upload`, { method: "POST", body: fd })
  if (!up.ok) throw new Error("upload SF gagal " + up.status)
  const fpath = (await up.json())[0]
  // panggil infer
  const call = await fetch(`${space}/gradio_api/call/infer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [
      { path: fpath, meta: { _type: "gradio.FileData" } },
      instruksiEn, 0, true, 2.5, 20,
    ] }),
  })
  if (!call.ok) throw new Error("panggil SF gagal " + call.status + " " + (await call.text()).slice(0, 100))
  const { event_id } = await call.json()
  // tunggu hasil (SSE)
  const sse = await fetch(`${space}/gradio_api/call/infer/${event_id}`)
  const res = await sseFinal(sse)
  if (!res.ok) throw new Error("SF error: " + (res.err || "").slice(0, 200))
  const arr = JSON.parse(res.data)
  const file = (Array.isArray(arr) ? arr.find(x => x?.url) : null) || null
  if (!file?.url) throw new Error("SF hasil tak dikenal: " + res.data.slice(0, 120))
  return file.url
}

// lihat foto: JARVIS menganalisis isi foto via Workers AI (LLaVA — gratis)
async function lihatFoto(env, chatId, photoArr, pertanyaan) {
  await kirimTeks(env, chatId, "👁️ JARVIS sedang melihat foto...")
  // pilih ukuran foto yang efisien (<250KB)
  const kecil = photoArr.filter(p => (p.file_size || 0) < 250000)
  const pick = kecil.length ? kecil[kecil.length - 1] : photoArr[photoArr.length - 1]
  const info = await (await tgSend(env.TG_TOKEN, "getFile", { file_id: pick.file_id })).json()
  const path = info?.result?.file_path
  if (!path) throw new Error("getFile gagal")
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}`)
  if (!r.ok) throw new Error("unduh foto gagal " + r.status)
  const bytes = new Uint8Array(await r.arrayBuffer())
  const input = { image: Array.from(bytes) }
  if (pertanyaan) input.prompt = String(pertanyaan).slice(0, 300)
  let res = null
  try { res = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", input) }
  catch (e) {
    if (pertanyaan) { // coba tanpa prompt (beberapa versi hanya terima image)
      res = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", { image: Array.from(bytes) })
    } else throw e
  }
  const ket = res?.description || JSON.stringify(res).slice(0, 300)
  const balasan = pertanyaan
    ? `👁️ Pertanyaan: ${pertanyaan}\n\n${ket}`
    : `👁️ Yang saya lihat di foto:\n\n${ket}`
  await kirimTeks(env, chatId, balasan.slice(0, 3500))
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
    // --- FOTO: /lihat = analisa isi foto; caption lain = perintah edit
    if (msg.photo?.length) {
      if (!teks)
        return await kirimTeks(env, chatId,
          "📸 Foto diterima! Pilih:\n" +
          "• Caption instruksi edit (contoh: ubah jadi hitam putih) → saya EDIT\n" +
          "• Caption /lihat atau /lihat <pertanyaan> → saya BACA & jelaskan foto")
      if (/^\/(lihat|analisa)\b/.test(teks)) {
        const pertanyaan = teks.replace(/^\/(lihat|analisa)\s*/, "").trim()
        await lihatFoto(env, chatId, msg.photo, pertanyaan || null).catch(async e => {
          console.log("lihat gagal:", String(e.message || e).slice(0, 160))
          await kirimTeks(env, chatId, "❌ Gagal membaca foto: " + String(e.message || e).slice(0, 200))
        })
        return
      }
      const instruksi = teks.replace(/^\/edit(foto)?\s*/, "").trim()
      if (!instruksi || (teks.startsWith("/") && !/^\/edit/.test(teks)))
        return await kirimTeks(env, chatId, "Tulis instruksi edit di caption, contoh: ubah jadi hitam putih (atau /lihat untuk membaca foto)")
      await editFoto(env, chatId, msg.photo, instruksi).catch(async e => {
        const m = String(e.message || e)
        console.log("edit gagal:", m.slice(0, 160))
        await kirimTeks(env, chatId, "⏳ " + m.slice(0, 250))
      })
      return
    }

    // --- DOKUMEN: file teks (.txt/.md/.csv/.json) dibaca & dijawab
    if (msg.document) {
      const mime = msg.document.mime_type || ""
      const nama = msg.document.file_name || "file"
      const didukung = mime.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(nama)
      if (!didukung)
        return await kirimTeks(env, chatId,
          `📄 File "${nama}" belum didukung.\n` +
          "Kirim file TEKS (.txt, .md, .csv, .json, .log) atau salin-tempel isinya ke chat ya.")
      const info = await (await tgSend(env.TG_TOKEN, "getFile", { file_id: msg.document.file_id })).json()
      const path = info?.result?.file_path
      if (!path) throw new Error("getFile dokumen gagal")
      const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}`)
      if (!r.ok) throw new Error("unduh dokumen gagal " + r.status)
      const isi = (await r.text()).slice(0, 12000)
      const pertanyaan = teks || "Ringkas dokumen ini poin per poin dalam Bahasa Indonesia."
      const jawab = await tanyaJawab(
        `DOKUMEN "${nama}" berisi:\n"""\n${isi}\n"""\n\nPERTANYAAN: ${pertanyaan}`,
        env, chatId)
      await kirimTeks(env, chatId, `📄 ${nama}\n\n${jawab}`)
      return
    }

    if (!teks) return

    if (teks === "/start" || teks === "/menu" || teks === "/bantuan")
      return await kirimTeks(env, chatId,
        "⚡ JARVIS INSTANT v3 (Cloudflare 24 jam)\n\n" +
        "• Ketik apa saja → dijawab INSTAN + INGAT konteks chat\n" +
        "• /gambar <deskripsi> → buat gambar AI\n" +
        "• FOTO + caption <instruksi> → EDIT foto\n" +
        "• FOTO + caption /lihat → saya BACA & jelaskan foto 👁️\n" +
        "• /storyboard <ide video> → naskah + gambar tiap adegan 🎬\n" +
        "• /search <topik> → cari info di web 🔍\n" +
        "• Kirim file .txt/.md/.csv → saya baca dokumen 📄\n" +
        "• /pikir on|off → mode berpikir dalam 🧠\n" +
        "• /reset → hapus ingatan\n" +
        "• /monitor → status sistem\n" +
        "• /video → info video\n" +
        "• /status → kondisi bot\n" +
        "• PWA: buka URL worker ini di HP → 'Add to Home Screen'")

    if (teks === "/status")
      return await kirimTeks(env, chatId,
        `✅ JARVIS v3 hidup\nJam UTC: ${new Date().toUTCString()}\n` +
        `Fitur: chat+memory / gambar / EDIT & BACA foto / dokumen / storyboard / search\n` +
        `Mode pikir: ${(await cfgGet(env, chatId)).pikir ? "AKTIF 🧠" : "mati ⚡"}\n` +
        `Ingatan: ${env.MEM ? "tersimpan (KV)" : "tidak tersedia"}\nTerima pesan: INSTAN (webhook)`)

    if (teks === "/reset") {
      await memSave(env, chatId, [])
      return await kirimTeks(env, chatId, "🧹 Ingatan percakapan dihapus. Kita mulai segar!")
    }

    if (teks === "/pikir" || teks.startsWith("/pikir ")) {
      const arg = teks.slice(6).trim().toLowerCase()
      const cfg = await cfgGet(env, chatId)
      if (arg === "on" || arg === "aktif") {
        cfg.pikir = true; await cfgSet(env, chatId, cfg)
        return await kirimTeks(env, chatId, "🧠 Mode PIKIR AKTIF — saya berpikir dulu sebelum menjawab (lebih akurat, sedikit lebih lambat).")
      }
      if (arg === "off" || arg === "mati") {
        cfg.pikir = false; await cfgSet(env, chatId, cfg)
        return await kirimTeks(env, chatId, "⚡ Mode PIKIR MATI — jawaban instan.")
      }
      return await kirimTeks(env, chatId, `🧠 Mode pikir: ${cfg.pikir ? "AKTIF" : "mati"}\nPakai: /pikir on atau /pikir off`)
    }

    if (teks === "/video" || teks.startsWith("/video "))
      return await kirimTeks(env, chatId,
        "🎬 Soal VIDEO konten:\n\n" +
        "Generator video AI gratisan di cloud belum tersedia (Veo/Sora hanya berbayar) — jadi video PENUH hanya bisa lewat bot PC: \n" +
        "→ @darksystemjarvis_bot → /video <ide>  (PC harus nyala, mesin FFmpeg)\n\n" +
        "Sedangkan saya (cloud, PC mati pun) bisa:\n" +
        "• Bikin NASKAH/naskah+storyboard video kamu → ketik: \"buat naskah video 30 detik tentang ...\"\n" +
        "• Bikin thumbnail/pending gambar via /gambar\n\n" +
        "Mau saya buatkan naskahnya sekarang? ")

if (teks === "/monitor") {
  const ip = (await (await fetch("https://api64.ipify.org")).text()).substring(0, 15)
  await kirimTeks(env, chatId,
    "🛡️ STATUS SISTEM JARVIS\n\n" +
    "• Worker: " + (await (await fetch("https://jarvis-instant.jarvis-manbis.workers.dev/health")).text()) + "\n" +
    "• Webhook: AKTIF (0 pending update)\n" +
    "• Z.AI key: " + (env.ZAI_KEY?.substring(0, 10) + "...") + " (aktif)\n" +
    "• CHATKEY: " + (env.CHATKEY?.substring(0, 6) + "...") + "\n" +
    "• IP publik: " + ip + "\n" +
    "• AI image: " + (env.AI ? "Workers AI (SDXL) aktif" : "tidak terpasang") + "\n" +
    "• Gambar edit: FLUX Kontext (Hugging Face) + Gemini cadangan\n" +
    "• Semua: GRATIS, tanpa kartu kredit")
  return
}

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

    if (teks === "/search") {
      return await kirimTeks(env, chatId, "Kirim: /search <topik> misal: /search artificial intelligence")
    }

    if (teks.startsWith("/search ")) {
      const query = teks.slice(8).trim().slice(0, 500)
      await kirimTeks(env, chatId, `🔍 Mencari: ${query}`)
      try {
        const r = await fetch(`https://text.pollinations.ai/${encodeURIComponent(query)}?system=JARVIS&max_tokens=500`, {
          method: "GET",
          headers: { "Accept": "text/plain" }
        })
        if (r.ok) {
          const result = await r.text()
          await kirimTeks(env, chatId, `🔍 Hasil search: ${query}\n\n${result.slice(0, 2000)}`)
        } else {
          await kirimTeks(env, chatId, "❌ Search gagal (status " + r.status + ")")
        }
      } catch (e) {
        await kirimTeks(env, chatId, "❌ Search error: " + String(e.message).slice(0, 200))
      }
      return
    }

    if (teks === "/storyboard")
      return await kirimTeks(env, chatId, "Pakai: /storyboard iklan kopi enak 30 detik")

    if (teks.startsWith("/storyboard ")) {
      const ide = teks.slice(12).trim().slice(0, 300)
      await kirimTeks(env, chatId, `🎬 Membuat storyboard video: ${ide}\n(tahap 1: naskah 4 adegan → tahap 2: gambar tiap adegan, mohon tunggu ±1-2 menit)`)
      try {
        const naskah = await tanyaJawab(
          `Buat storyboard video pendek (30-45 detik) dengan 4 adegan untuk ide: "${ide}". ` +
          `Format tiap adegan: ADEGAN <n> — deskripsi visual singkat + narasi/teks 1 kalimat. ` +
          `Setelah itu tulis bagian berjudul "PROMPTS:" berisi 4 prompt gambar Bahasa Inggris (satu per adegan, untuk image generator), dipisah baris kosong.`,
          env, chatId)
        await kirimTeks(env, chatId, naskah.slice(0, 3500))
        const prompts = (naskah.split(/PROMPTS?:/i)[1] || "")
          .split(/\n\s*\n/).map(s => s.trim().replace(/\n/g, ", ")).filter(Boolean).slice(0, 4)
        for (let i = 0; i < prompts.length; i++) {
          try {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompts[i])}?width=1024&height=576&nologo=true&seed=${(Date.now() % 1000000) + i}`
            await kirimFoto(env, chatId, url, `🎬 Adegan ${i + 1}`)
          } catch (e) { console.log("storyboard img gagal:", String(e.message).slice(0, 100)) }
        }
      } catch (e) {
        await kirimTeks(env, chatId, "❌ Storyboard gagal: " + String(e.message || e).slice(0, 200))
      }
      return
    }

    const jawab = await tanyaJawab(teks, env, chatId)
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
