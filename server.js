require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleProxy, handleResolve } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord renders Activities inside an iframe on discord.com / discordsays.com.
// Make sure we never send a header that blocks framing there.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com;"
  );
  next();
});

// Client-side code fetches the Discord application's client id from here
// instead of it being hardcoded into the bundle.
app.get('/config', (req, res) => {
  res.json({ clientId: process.env.DISCORD_CLIENT_ID || '' });
});

// Given a pasted embed page, scrape out its playable media URL so the custom
// player can load it directly (instead of embedding the site's own player).
app.get('/resolve', handleResolve);

// ---- Shared "what's playing" state, so everyone in the same activity sees
// the same thing without each person pasting a link ----
//
// Keyed by the Discord activity instance id (unique per running activity in a
// voice channel), so different channels don't clobber each other. In-memory is
// fine: a single Render instance, and losing it on restart just means the host
// re-loads once. Entries are pruned by age to bound memory.
const roomState = new Map(); // instance -> { input, updatedAt }
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

function pruneRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [key, val] of roomState) {
    if (val.updatedAt < cutoff) roomState.delete(key);
  }
}

app.get('/state', (req, res) => {
  const key = String(req.query.instance || 'default');
  const s = roomState.get(key);
  res.json(s ? { input: s.input, updatedAt: s.updatedAt } : { input: null, updatedAt: 0 });
});

app.post('/state', express.json({ limit: '64kb' }), (req, res) => {
  const key = String(req.query.instance || 'default');
  const input = req.body && typeof req.body.input === 'string' ? req.body.input : '';
  if (!input) {
    res.status(400).json({ error: 'missing input' });
    return;
  }
  if (roomState.size > 1000) pruneRooms();
  roomState.set(key, { input, updatedAt: Date.now() });
  res.json({ ok: true, updatedAt: roomState.get(key).updatedAt });
});

// Captures the raw body for any content type so non-GET requests made by
// proxied pages (form posts, XHR bodies) can be forwarded upstream as-is.
app.use('/proxy', express.raw({ type: () => true, limit: '50mb' }));
app.all('/proxy', handleProxy);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Activity server listening on http://localhost:${PORT}`);
});
