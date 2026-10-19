// POST /api/highlights
// Header: x-groq-key (atau env GROQ_API_KEY)
// Body JSON: { text: "[detik] kalimat\n...", from: detikAwal, to: detikAkhir }
// Balasan: { clips: [{start, end, title, score}], keywords: ["kata", ...], model }
//
// Model dipilih otomatis: route menanyakan Groq model apa yang boleh dipakai key ini,
// lalu mencoba kandidat satu per satu sampai ada yang berhasil.

const BASE = 'https://api.groq.com/openai/v1';

const PREFER = [
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'minimaxai/minimax-m2.7',
];
const NOT_CHAT = /whisper|guard|safeguard|tts|orpheus|playai|embed|moderation/i;

const SYSTEM = [
  'Kamu editor klip viral untuk TikTok/Reels/Shorts.',
  'Dari transkrip berformat "[detik] teks", pilih paling banyak 2 segmen yang berdiri sendiri.',
  'Aturan segmen: durasi 15 sampai 45 detik, dimulai dengan hook kuat (pertanyaan, klaim berani, atau cerita), berakhir di akhir kalimat.',
  'Gunakan angka detik persis dari transkrip untuk start dan end.',
  'Beri score 1 sampai 10 untuk potensi viral.',
  'Pilih juga sampai 12 kata kunci (satu kata, huruf kecil) dari segmen terpilih yang pantas ditonjolkan di layar.',
  'Balas HANYA JSON: {"clips":[{"start":0,"end":0,"title":"","score":0}],"keywords":[""]}',
].join(' ');

const modelCache = new Map(); // key -> { at, ids }

async function listModels(key) {
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ids;
  try {
    const r = await fetch(BASE + '/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) return null;
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter(Boolean);
    modelCache.set(key, { at: Date.now(), ids });
    return ids;
  } catch (e) {
    return null;
  }
}

function pickCandidates(ids) {
  if (!ids) return PREFER.slice();
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  const first = PREFER.filter((id) => chat.includes(id));
  const rest = chat.filter((id) => !first.includes(id));
  return first.concat(rest).slice(0, 5);
}

function extractJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

async function ask(key, model, text, withFormat) {
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text },
    ],
  };
  if (withFormat) body.response_format = { type: 'json_object' };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true, data: await r.json() };
  const txt = await r.text();
  return { ok: false, status: r.status, txt, retry: Number(r.headers.get('retry-after')) || 0 };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Gunakan POST' });
    return;
  }
  const key = String(req.headers['x-groq-key'] || process.env.GROQ_API_KEY || '').trim();
  if (!key) {
    res.status(500).json({ error: 'API Key Groq belum diisi. Isi di kolom API Key pada halaman, lalu Simpan.' });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const text = String((body && body.text) || '').slice(0, 12000);
    const from = Number(body && body.from) || 0;
    const to = Number(body && body.to) || 0;
    if (!text.trim()) {
      res.status(400).json({ error: 'Transkrip kosong' });
      return;
    }

    const ids = await listModels(key);
    const candidates = pickCandidates(ids);
    const tried = [];
    let maxRetry = 0, saw429 = false, parsed = null, used = '';

    for (const model of candidates) {
      let r = await ask(key, model, text, true);
      if (!r.ok && r.status === 400 && /response_format|json/i.test(r.txt)) r = await ask(key, model, text, false);
      if (!r.ok) {
        tried.push(model + ' (' + r.status + ')');
        if (r.status === 401) {
          res.status(401).json({ error: 'API Key Groq ditolak (tidak valid). Cek key lalu Simpan lagi.' });
          return;
        }
        if (r.status === 429) { saw429 = true; maxRetry = Math.max(maxRetry, r.retry); }
        continue;
      }
      let p = null;
      try { p = extractJson(r.data.choices[0].message.content); } catch (e) { p = null; }
      if (!p) { tried.push(model + ' (balasan bukan JSON)'); continue; }
      parsed = p; used = model;
      break;
    }

    if (!parsed) {
      if (saw429) {
        res.status(429).json({ error: 'Batas Groq tercapai untuk semua model yang tersedia.', retryAfter: maxRetry });
        return;
      }
      res.status(502).json({
        error: 'Tidak ada model Groq yang bisa dipakai key ini. Dicoba: ' + (tried.join(', ') || 'tidak ada model') +
          (ids ? '. Model tersedia di key-mu: ' + ids.filter((i) => !NOT_CHAT.test(i)).join(', ') : ''),
      });
      return;
    }

    const clips = (Array.isArray(parsed.clips) ? parsed.clips : [])
      .map((c) => ({
        start: Number(c.start),
        end: Number(c.end),
        title: String(c.title || 'Momen').slice(0, 80),
        score: Math.max(1, Math.min(10, Number(c.score) || 5)),
      }))
      .filter((c) => isFinite(c.start) && isFinite(c.end) && c.end > c.start)
      .map((c) => {
        if (to > from) {
          c.start = Math.max(from, c.start);
          c.end = Math.min(to, c.end);
        }
        if (c.end - c.start > 60) c.end = c.start + 60;
        return c;
      })
      .filter((c) => c.end - c.start >= 8);

    const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .map((k) => String(k).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((k) => k.length > 2)
      .slice(0, 20);

    res.status(200).json({ clips, keywords, model: used });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}

export const config = { maxDuration: 60 };
