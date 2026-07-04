require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleProxy } = require('./proxy');

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

// Captures the raw body for any content type so non-GET requests made by
// proxied pages (form posts, XHR bodies) can be forwarded upstream as-is.
app.use('/proxy', express.raw({ type: () => true, limit: '50mb' }));
app.all('/proxy', handleProxy);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Activity server listening on http://localhost:${PORT}`);
});
