# ☁️ JARVIS CLOUD — AI Telegram 24 Jam via GitHub

Sama seperti Kripto Pantau: **dijalankan GitHub Actions**, gratis, tanpa PC, tanpa kartu kredit.

```
HP (Telegram) → bot Telegram → GitHub Actions (bangun tiap ±5 mnt) → Z.AI GLM → balasan
```

## Isi folder
| File | Fungsi |
|------|--------|
| `bot-ai.js` | Bot AI (tanpa dependensi) |
| `state.json` | Offset pesan (di-commit tiap siklus) |
| `.github/workflows/ai-chat.yml` | Cron GitHub |

## Langkah setup (±10 menit)

### 1. Buat bot KE-2 di BotFather (biar tidak bentrok dengan Kripto)
- Telegram → @BotFather → `/newbot`
- Nama: `Jarvis AI`, Username: misal `jarvis_manbis_bot`
- ⚠️ Simpan token baru — JANGAN pakai token kripto yang lama

### 2. Buat repo GitHub BARU (PUBLIC — gratis unlimited menit Actions)
- github.com → New repository → `jarvis-cloud` → **Public** → Create

### 3. Upload isi folder ini ke repo (PC punya git)
```powershell
cd C:\Users\Manbis\OPENCODE\projek\jarvis-cloud
git init
git add .
git commit -m "jarvis cloud v1"
git branch -M main
git remote add origin https://github.com/USERNAME/jarvis-cloud.git
git push -u origin main
```

### 4. Tambahkan 3 Secrets di repo
GitHub → Settings → Secrets and variables → Actions → New repository secret:
| Name | Isi |
|------|-----|
| `TELEGRAM_TOKEN_AI` | token bot ke-2: `@opencodedarksystem_bot` |
| `TELEGRAM_CHAT_ID` | `861253625` (chat ID kamu) |
| `ZAI_API_KEY` | key Z.AI kamu (dari https://z.ai/manage-apikey/apikey-list) |

### 5. Aktifkan & test
- Repo → tab **Actions** → workflow "JARVIS Cloud AI" → **Run workflow** (test manual)
- Lalu cron otomatis bangun tiap ±5 menit
- HP → kirim "halo" ke bot ke-2 → jawaban ±1–10 menit

## Batasan jujur
- Jawaban tidak instan (walk up setiap ±5 menit; kadang antre GitHub)
- Tidak bisa akses file/PC (versi cloud = jawab & gambar saja)
- Versi penuh (instan + gambar/video + kontrol PC) tetap tersedia saat PC hidup

## Bedanya dengan Kripto Pantau
| | Kripto | JARVIS Cloud |
|--|--------|--------------|
| Interval cron | 15 menit | 5 menit |
| Tugas | analisa harga | jawab chat + gambar |
| Key AI | OpenRouter | Z.AI GLM |
