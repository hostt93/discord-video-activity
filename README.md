# Discord Video Player Activity

A Discord **Activity** — the thing you launch from the rocket icon in a
voice channel (like Watch Together), not a message embed — that lets you
paste in *any* embed link (or full `<iframe>` snippet) and play it. A bot
can't post a raw `<iframe>` into chat; Discord only allows iframes inside a
properly registered Activity, which is what this project sets up.

## How it's wired

- `server.js` — serves `public/` (the activity's web page) over HTTP.
- `proxy.js` — a generic rewriting reverse-proxy (`/proxy?url=...`). This is
  the key piece: Discord's Activity iframe can only load domains you've
  pre-registered in the Developer Portal's URL Mappings, so instead of
  registering every possible video-embed domain, everything routes through
  this one proxy on your own server (which *is* pre-registered, as the
  root mapping). The proxy fetches the real target server-side, strips
  headers that would block framing (`X-Frame-Options`, restrictive
  `Content-Security-Policy`), and rewrites embedded URLs (HTML attributes,
  CSS `url()`, HLS `.m3u8` playlists) so sub-resources also route back
  through it. A small injected script also patches `fetch`/`XMLHttpRequest`
  so JS-driven players (e.g. hls.js) that build URLs at runtime still get
  proxied.
- `public/index.html` / `public/main.js` — the page Discord loads inside the
  voice channel. It shows a paste box; whatever URL or `<iframe>` snippet
  you paste gets sent through `/proxy` and dropped into the player iframe.
  The last link used is remembered per-browser via `localStorage`.
- `deploy-commands.js` — registers a **Primary Entry Point** slash command
  (`/watch` by default). Discord launches the Activity itself when this
  command is used — no bot process needs to be running for the launch to
  work.
- `bot.js` — a small discord.js bot with a `/status` command, just to have a
  live bot process for anything else you want to add later.

## 1. Create the Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → Add Bot → copy the **token** → put it in `.env` as `DISCORD_BOT_TOKEN`.
3. **OAuth2** tab → copy the **Client ID** (top of General Information page) → put it in `.env` as `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator**: scopes `applications.commands` and `bot`, then use the generated URL to invite the app to your server.

## 2. Enable Activities

1. In the app's dashboard, open the **Activities** tab and enable Activities for this app.
2. Under **URL Mappings**, add just one entry:
   | Prefix | Target |
   |---|---|
   | `/` | your activity host (see step 3) |

   That's the only mapping you'll ever need — links you paste into the
   activity are fetched through `/proxy` on this same server, not loaded as
   direct external iframes, so there's nothing to add per-site.

## 3. Host the activity

Discord needs a public HTTPS URL (localhost won't work). For local testing:

```bash
npm install
cp .env.example .env      # fill in DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID
npm start                 # runs server.js on PORT (default 3000)
```

In another terminal, tunnel it (either works):

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Take the `https://...` URL it gives you and set it as the `/` target in
the URL Mappings from step 2. For real/production use, deploy `server.js`
to any Node host (Render, Fly.io, a VPS, etc.) and point `/` at that
instead of a tunnel.

## 4. Register the launch command

```bash
npm run deploy-commands
```

This registers `/watch` (rename via `ACTIVITY_COMMAND_NAME` in `.env` before
running) as the app's Primary Entry Point command, plus a `/status` command.

## 5. Run the bot (optional, for `/status`)

```bash
npm run bot
```

## 6. Launch it and paste a link

In a voice channel where the app is added: click the rocket/apps icon and
pick your activity, or type `/watch`. Discord opens the activity for
everyone in the channel. Paste an embed link (or a full `<iframe ...>`
snippet — it'll extract the `src` automatically) into the bar at the top
and click **Load**. The link is remembered in that browser's `localStorage`,
so relaunching the same client reloads the last thing played.

## Known limitations

- **Not every player will work.** The proxy rewrites HTML/CSS/HLS
  playlists and patches `fetch`/`XHR` so most embed players load fine, but
  players that use WebSockets, WebRTC, DRM (Widevine/FairPlay), or heavy
  obfuscation to construct URLs may still fail. Open the activity's dev
  tools (desktop client, developer mode, `Ctrl+Shift+I`) and check the
  Network tab for anything failing/red if a link doesn't play.
- **Referer/hotlink checks**: the proxy sets `Referer`/`Origin` to the
  target's own domain when fetching, which satisfies simple hotlink
  protection, but a site with a strict allow-list of embedding domains may
  still refuse to serve content to it.
- **No cookies/login forwarded**: the proxy doesn't forward `Set-Cookie`
  from the target back to the browser, so sites that require a login or
  session to play their embed won't work through this.
- **Security**: this proxy will fetch whatever URL it's given (blocking only
  localhost/private-IP ranges to avoid SSRF into your own network). Don't
  expose it more broadly than you're comfortable with — anyone who can reach
  your activity's URL can use it as a general-purpose fetch proxy.
- **Content rights**: make sure you're allowed to redistribute/embed
  whatever you paste in to your server's members — that's on you, not
  something this scaffold controls.
