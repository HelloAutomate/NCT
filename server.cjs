// server.cjs
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

// -------- ENV (tolerant names)
const PORT = Number(process.env.PORT || 3000);

const ELEVEN_KEY =
  process.env.ELEVEN_API_KEY ||
  process.env.ELEVENLABS_API_KEY ||
  '';

const ELEVEN_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID ||
  process.env.AGENT_ID ||
  '';

const FAQ_URL = process.env.FAQ_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';       // Make.com webhook
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || '';       // optional header x-make-apikey
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@ncts.ie';

// Node 18+ has global fetch

app.use(express.json());

// -------- Static + index
const publicDir = path.join(process.cwd(), 'public');
app.use('/public', express.static(publicDir));
app.use('/assets', express.static(publicDir)); // optional alias

function resolveIndexPath() {
  const rootIndex = path.join(process.cwd(), 'index.html');
  const publicIndex = path.join(publicDir, 'index.html');
  try { fs.accessSync(rootIndex); return rootIndex; } catch {}
  return publicIndex;
}

app.get('/', (_req, res) => {
  try { res.sendFile(resolveIndexPath()); }
  catch (e) { res.status(500).send(String(e)); }
});

// -------- Viewer WS (fan-out to dashboard)
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

wss.on('connection', ws => {
  ws.on('message', () => {});
});

// -------- Demo call lifecycle + transcript/status
app.post('/api/call/start', (_req, res) => { broadcast({ type: 'started', at: Date.now() }); res.json({ ok: true }); });
app.post('/api/call/stop',  (_req, res) => { broadcast({ type: 'ended',   at: Date.now() }); res.json({ ok: true }); });

app.post('/rt/transcript', (req, res) => {
  const { role, text } = req.body || {};
  if (text) broadcast({ type: 'transcript', role: role || 'caller', text });
  res.json({ ok: true });
});

app.post('/rt/status', (req, res) => {
  const { text } = req.body || {};
  if (text) broadcast({ type: 'status', text });
  res.json({ ok: true });
});

// -------- FAQs
app.get('/api/faq', async (_req, res) => {
  try {
    if (FAQ_URL) {
      const r = await fetch(FAQ_URL);
      const j = await r.json();
      return res.json(j);
    }
  } catch {}
  res.json({
    items: [
      { q: 'What do I need to book an NCT slot?', a: 'Registration, preferred test centre, and date/time.' },
      { q: 'Can I reschedule?', a: 'Yes, up to 24 hours before the appointment.' },
      { q: 'How do I pay?', a: 'Online payment at the end of booking.' }
    ]
  });
});

// -------- Email invite webhook (demo-friendly)
// POST { email, loc, date, time, phone }
app.post('/api/email-confirm', async (req, res) => {
  const { email, loc, date, time, phone } = req.body || {};
  if (!email || !loc || !date || !time) {
    return res.json({ ok: false, error: 'missing fields' });
  }

  // If no webhook configured, succeed locally for demo
  if (!WEBHOOK_URL) {
    console.log('[email demo] Would send invite:', { email, loc, date, time, phone });
    return res.json({ ok: true, demo: true });
  }

  try {
    const payload = {
      type: 'nct_email_invite',
      from: FROM_EMAIL,
      to: email,
      subject: 'NCT Appointment Confirmation',
      data: { location: loc, date, time, phone }
    };
    const headers = { 'content-type': 'application/json' };
    if (WEBHOOK_KEY) headers['x-make-apikey'] = WEBHOOK_KEY;

    const r = await fetch(WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.json({ ok: false, error: `webhook ${r.status}: ${txt}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// -------- ElevenLabs signed WS URL
app.get('/ws-signed-url', async (_req, res) => {
  try {
    if (!ELEVEN_AGENT_ID) {
      return res.json({ url: '', error: 'missing ELEVENLABS_AGENT_ID / AGENT_ID' });
    }

    // Agent is in Public mode
    if (!ELEVEN_KEY) {
      return res.json({
        url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`,
        note: 'public-fallback (no ELEVEN_API_KEY set)'
      });
    }

    const endpoints = [
      'https://api.elevenlabs.io/v1/convai/conversation',
      'https://api.elevenlabs.io/v1/convai/conversations'
    ];
    const headers = { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' };

    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers,
          body: JSON.stringify({ agent_id: ELEVEN_AGENT_ID })
        });
        if (!r.ok) continue;

        const j = await r.json().catch(() => ({}));
        const url =
          j.websocket_url ||
          j.ws_url ||
          j.url ||
          (j.data && j.data.url) ||
          '';

        if (url) return res.json({ url, source: ep });
      } catch {
        // try next
      }
    }

    // Signing not available; fall back to public URL (works if agent is Public)
    return res.json({
      url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`,
      note: 'public-fallback (signing endpoints not available)'
    });
  } catch (e) {
    return res.json({ url: '', error: String(e) });
  }
});

// -------- Boot
server.listen(PORT, () => {
  console.log(`[boot] http://localhost:${PORT}`);
  if (!ELEVEN_KEY) console.warn('[warn] ELEVEN_API_KEY / ELEVENLABS_API_KEY is not set (using public fallback if agent is Public).');
  if (!ELEVEN_AGENT_ID) console.warn('[warn] ELEVENLABS_AGENT_ID / AGENT_ID is not set.');
});
