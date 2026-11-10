# Kineflex Backend - Cloudflare Worker Edition

A high-performance streaming backend migrated from Express to **Cloudflare Workers** with **Cloudflare KV Storage** and integrated with **`player.kineflex.site`**.

---

## 🚀 Key Improvements & Updates

1. **Cloudflare Worker Runtime:**
   - Ultra-fast edge performance with zero cold starts.
   - Built using standard Web Fetch APIs (`Request`, `Response`, `URL`).
   - Global CORS headers enabled on all endpoints.

2. **Cloudflare KV Storage for `data.json`:**
   - Media collections, hero movies, logos, and categories are stored directly in Cloudflare KV (`KINFLEX_KV`).
   - If not yet initialized in KV, it automatically falls back to the bundled catalog (`src/defaultData.js`).
   - Instant live updates across all global edge locations when saved from the Admin Dashboard.

3. **New Streaming Player Integration (`player.kineflex.site`):**
   - Completely removed old `video.json` and `peachify.top` logic.
   - Movie streams: `https://player.kineflex.site/movie/{id}?key={base64_api_key}`
   - TV streams: `https://player.kineflex.site/tv/{id}/{season}/{episode}?key={base64_api_key}`
   - **Base64 Key Obfuscation:** The live secret key `kine_live_9AuUd4Y1uqQ-GGACHQGNBIxn2E4oxm7H` is automatically Base64-encoded (`a2luZV9saXZlXzlBdVVkNFkxdXFRLUdHQUNIUUdOQkl4bjJFNG94bTdI`) to keep the plaintext API key completely hidden from the browser address bar.

4. **Upgraded Admin Panel (`/admin` or `/344.html`):**
   - Served directly from the Cloudflare Worker.
   - **Player Settings Tab:** View active Player API Key, live Base64 preview, instant Cloudflare KV updates, and single-click player testing.
   - **`data.json` Management:** Visual editor + Raw JSON editor with real-time JSON validation and save to Cloudflare KV.

---

## 🛠️ Deployment Instructions

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Create Cloudflare KV Namespace
Run the following command to create your production KV namespace:
```bash
npx wrangler kv:namespace create KINFLEX_KV
```
You will get an output like:
```
[[kv_namespaces]]
binding = "KINFLEX_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Also create a preview namespace for local development (optional):
```bash
npx wrangler kv:namespace create KINFLEX_KV --preview
```

### Step 3: Update `wrangler.toml`
Paste the generated `id` and `preview_id` into [`wrangler.toml`](./wrangler.toml):
```toml
[[kv_namespaces]]
binding = "KINFLEX_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
preview_id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
```

### Step 4: Test Locally
```bash
npm run dev
```
Open [http://localhost:8787](http://localhost:8787) in your browser:
- Status page: `http://localhost:8787/`
- Admin Dashboard: `http://localhost:8787/admin`
- Data Catalog: `http://localhost:8787/data.json`

### Step 5: Deploy to Cloudflare Workers
```bash
npm run deploy
```
Your worker will be live globally at:
`https://kinflex-backend.<your-subdomain>.workers.dev`

---

## 📡 API Endpoints Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | Worker health status page. |
| `/data.json` | `GET` | Returns `data.json` from Cloudflare KV. |
| `/api/play` | `POST / GET` | Returns player URL with Base64 key: `{ success: true, url: "https://player.kineflex.site/..." }`. |
| `/api/search` | `GET` | TMDB search and genre/language discover proxy. |
| `/api/trending` | `GET` | TMDB trending content proxy. |
| `/api/details/:type/:id` | `GET` | Full TMDB details (credits, trailers, seasons, episodes). |
| `/api/continue-watching` | `ALL` | Watch history metadata enrichment. |
| `/api/channels` | `GET` | Live TV channels from CDN. |
| `/api/stream` | `GET` | Resolves live HLS `.m3u8` streams. |
| `/admin` or `/344.html` | `GET` | Built-in Admin Dashboard UI. |
| `/api/admin/files` | `GET` | Lists editable files (`['data.json']`). |
| `/api/admin/file` | `GET / POST` | Reads / writes `data.json` to Cloudflare KV (requires `X-Admin-Password`). |
| `/api/admin/settings` | `GET / POST` | Reads / writes Player API Key to Cloudflare KV (requires `X-Admin-Password`). |

---

## 🔐 Credentials & Secrets

- **Default Admin Password:** `9310081539` (can be customized via `ADMIN_PASSWORD` variable).
- **Default Player API Key:** `kine_live_9AuUd4Y1uqQ-GGACHQGNBIxn2E4oxm7H` (editable directly in Admin Panel).
- **TMDB Key:** `e6333b32409e02a4a6eba6fb7ff866bb` (can be overridden via `TMDB_KEY` variable).

---

## 🌐 Connecting Your Frontend

In your frontend application (`index.html`, `detail.html`, etc.), update `API_BASE`:
```javascript
const API_BASE = 'https://kinflex-backend.<your-subdomain>.workers.dev';
```
All frontend calls (`/api/play`, `/api/search`, `/api/details`, `/data.json`) will immediately use your new Cloudflare Worker.
