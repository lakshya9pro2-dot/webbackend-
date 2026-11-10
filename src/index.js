import { DEFAULT_DATA } from './defaultData.js';
import { getAdminHtml } from './adminHtml.js';

// ══════════════════════════════════════════════════════════════
//  KINEFLEX CLOUDFLARE WORKER BACKEND
//  - Persistent Storage: Cloudflare KV (KINFLEX_KV)
//  - Streaming Player: player.kineflex.site (Base64 Key Obfuscation)
//  - TMDB Proxy & Live TV Resolver
//  - Built-in Admin Dashboard (/admin, /344.html)
// ══════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Password, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 500, extra = {}) {
  return jsonResponse({ success: false, message, ...extra }, status);
}

// In-memory cache for fast warm-worker responses
const memoryCache = {
  channels: { data: null, timestamp: 0 },
  streams: new Map(),
  tmdb: new Map(),
};

const LANG_MAP = {
  'hindi': 'hi',
  'english': 'en',
  'telugu': 'te',
  'tamil': 'ta',
  'malayalam': 'ml',
  'bengali': 'bn',
  'kannada': 'kn',
  'marathi': 'mr',
  'punjabi': 'pa'
};

function getGenreId(genreName, mediaType) {
  const name = (genreName || '').toLowerCase().trim();
  if (mediaType === 'tv') {
    if (name === 'action') return 10759;
    if (name === 'sci-fi') return 10765;
  }
  const map = {
    'action': 28,
    'romance': 10749,
    'comedy': 35,
    'drama': 18,
    'thriller': 53,
    'horror': 27,
    'reality': 10764,
    'animation': 16,
    'documentary': 99,
    'sci-fi': 878,
    'mystery': 9648
  };
  return map[name] || null;
}

function parseTMDBUrl(url) {
  if (!url) return null;
  let match = url.match(/themoviedb\.org\/movie\/(\d+)/i);
  if (match) return { tmdb_id: match[1], media_type: 'movie' };
  match = url.match(/themoviedb\.org\/tv\/(\d+)/i);
  if (match) return { tmdb_id: match[1], media_type: 'tv' };
  return null;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const seconds = totalSecs % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION & CLOUDFLARE KV HELPERS
// ══════════════════════════════════════════════════════════════

function getAdminPassword(env) {
  return env.ADMIN_PASSWORD || '9310081539';
}

function getTmdbKey(env) {
  return env.TMDB_KEY || 'e6333b32409e02a4a6eba6fb7ff866bb';
}

async function getPlayerApiKey(env) {
  if (env.KINFLEX_KV) {
    const val = await env.KINFLEX_KV.get('player_api_key');
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }
  return env.DEFAULT_PLAYER_API_KEY || 'kine_live_9AuUd4Y1uqQ-GGACHQGNBIxn2E4oxm7H';
}

async function setPlayerApiKey(env, newKey) {
  const trimmed = (newKey || '').trim();
  if (!trimmed) throw new Error('API key cannot be empty');
  if (env.KINFLEX_KV) {
    await env.KINFLEX_KV.put('player_api_key', trimmed);
    return { success: true, storage: 'cloudflare_kv' };
  }
  return { success: true, storage: 'fallback_memory' };
}

async function getDataJson(env) {
  if (env.KINFLEX_KV) {
    const val = await env.KINFLEX_KV.get('data.json');
    if (val) {
      try {
        return JSON.parse(val);
      } catch (err) {
        console.error('Error parsing data.json from KV:', err);
      }
    }
  }
  return DEFAULT_DATA;
}

async function getDataJsonString(env) {
  if (env.KINFLEX_KV) {
    const val = await env.KINFLEX_KV.get('data.json');
    if (val) return val;
  }
  return JSON.stringify(DEFAULT_DATA, null, 2);
}

async function saveDataJsonString(env, content) {
  JSON.parse(content); // Ensure valid JSON
  if (env.KINFLEX_KV) {
    await env.KINFLEX_KV.put('data.json', content);
    return { success: true, storage: 'cloudflare_kv' };
  }
  return { success: true, storage: 'fallback_memory', warning: 'KINFLEX_KV not bound; persistent storage requires KV binding' };
}

function checkAdminAuth(request, env) {
  const expected = getAdminPassword(env);
  const headerPwd = request.headers.get('x-admin-password');
  const url = new URL(request.url);
  const queryPwd = url.searchParams.get('password');
  return (headerPwd === expected || queryPwd === expected);
}

// ══════════════════════════════════════════════════════════════
//  TMDB PROXY FUNCTIONS
// ══════════════════════════════════════════════════════════════

async function tmdbFetch(path, extraParams = {}, env) {
  const apiKey = getTmdbKey(env);
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('include_adult', 'false');
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TMDB ${res.status}: ${err}`);
  }
  return res.json();
}

async function discoverFetch(type, genre, lang, page, env) {
  const params = { page };
  if (genre) {
    const genreId = getGenreId(genre, type);
    if (genreId) params.with_genres = genreId;
  }
  if (lang) {
    const langCode = LANG_MAP[lang.toLowerCase().trim()];
    if (langCode) params.with_original_language = langCode;
  }
  return tmdbFetch(`/discover/${type}`, params, env);
}

async function getSeasonEpisodes(tvId, seasonNumber, env) {
  try {
    const data = await tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`, {}, env);
    return (data.episodes || []).map(ep => ({
      id: ep.id,
      name: ep.name,
      overview: ep.overview,
      episodeNumber: ep.episode_number,
      seasonNumber: ep.season_number,
      airDate: ep.air_date,
      still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : 'https://via.placeholder.com/300x169/1a1a2e/e8a020?text=No+Image',
      rating: ep.vote_average ? parseFloat(ep.vote_average.toFixed(1)) : 0,
      voteCount: ep.vote_count || 0,
    }));
  } catch (err) {
    console.error(`Failed to fetch episodes for TV Show ${tvId} Season ${seasonNumber}:`, err.message);
    return [];
  }
}

async function getFullDetails(type, id, env) {
  const appendToResponse = type === 'movie'
    ? 'credits,videos,release_dates,similar'
    : 'credits,videos,content_ratings,similar';

  const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: appendToResponse }, env);

  // Certifications
  let certification = '';
  const certifications = {};
  if (type === 'movie' && data.release_dates && data.release_dates.results) {
    for (const r of data.release_dates.results) {
      const country = r.iso_3166_1;
      const release = r.release_dates.find(d => d.certification !== '');
      if (release) {
        certifications[country] = release.certification;
        if (country === 'US') certification = release.certification;
      }
    }
    if (!certification && Object.values(certifications).length > 0) {
      certification = Object.values(certifications)[0];
    }
  } else if (type === 'tv' && data.content_ratings && data.content_ratings.results) {
    for (const r of data.content_ratings.results) {
      const country = r.iso_3166_1;
      certifications[country] = r.rating;
      if (country === 'US') certification = r.rating;
    }
    if (!certification && Object.values(certifications).length > 0) {
      certification = Object.values(certifications)[0];
    }
  }

  // Cast and Crew
  let director = '';
  let writers = [];
  let producers = [];
  let cast = [];
  let crew = [];
  if (data.credits) {
    const crewList = data.credits.crew || [];
    const directors = crewList.filter(c => c.job === 'Director').map(c => c.name);
    director = directors.join(', ');
    writers = [...new Set(crewList.filter(c => c.department === 'Writing').map(c => c.name))];
    producers = [...new Set(crewList.filter(c => c.job === 'Producer' || c.job === 'Executive Producer').map(c => c.name))];
    cast = (data.credits.cast || []).slice(0, 15).map(c => ({
      name: c.name,
      character: c.character,
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : 'https://via.placeholder.com/185x278/1a1a2e/e8a020?text=No+Photo',
    }));
    crew = crewList.map(c => ({
      name: c.name,
      job: c.job,
      department: c.department,
    }));
  }

  // Trailers
  let trailers = [];
  if (data.videos && data.videos.results) {
    trailers = data.videos.results
      .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .map(v => ({
        name: v.name,
        url: `https://www.youtube.com/watch?v=${v.key}`,
        key: v.key,
      }));
  }

  // Similar
  let similar = [];
  if (data.similar && data.similar.results) {
    similar = data.similar.results.slice(0, 12).map(s => ({
      id: s.id,
      title: s.title || s.name || 'Unknown',
      poster: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : 'https://via.placeholder.com/342x513/1a1a2e/e8a020?text=No+Image',
      rating: s.vote_average ? s.vote_average.toFixed(1) : '—',
      year: (s.release_date || s.first_air_date || '').slice(0, 4),
    }));
  }

  // Seasons (TV Only)
  let seasons = [];
  if (type === 'tv' && data.seasons) {
    const activeSeasons = data.seasons.filter(s => s.season_number > 0);
    seasons = await Promise.all(activeSeasons.map(async (s) => {
      const episodes = await getSeasonEpisodes(id, s.season_number, env);
      return {
        id: s.id,
        name: s.name,
        seasonNumber: s.season_number,
        episodeCount: s.episode_count,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : 'https://via.placeholder.com/342x513/1a1a2e/e8a020?text=No+Image',
        overview: s.overview || '',
        airDate: s.air_date || '',
        episodes,
      };
    }));
  }

  return {
    id: data.id,
    type,
    title: data.title || data.name || 'Unknown',
    originalTitle: data.original_title || data.original_name || 'Unknown',
    releaseYear: (data.release_date || data.first_air_date || '').slice(0, 4),
    releaseDate: data.release_date || data.first_air_date || '',
    overview: data.overview || '',
    runtime: data.runtime || (data.episode_run_time && data.episode_run_time[0]) || null,
    genres: (data.genres || []).map(g => g.name),
    certification,
    certifications,
    poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : 'https://via.placeholder.com/500x750/1a1a2e/e8a020?text=No+Image',
    backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : '',
    rating: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : 0,
    voteCount: data.vote_count || 0,
    productionCompanies: (data.production_companies || []).map(c => c.name),
    director,
    writers,
    producers,
    cast,
    crew,
    trailers,
    similar,
    seasons,
  };
}

// ══════════════════════════════════════════════════════════════
//  LIVE TV STREAM RESOLVER
// ══════════════════════════════════════════════════════════════

function decodeBase64(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    return atob(s);
  } catch (e) {
    return s;
  }
}

function resolveStreamUrl(htmlContent) {
  const decodeFuncRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(s\)\s*\{\s*s\s*=\s*s\.replace/;
  const funcMatch = htmlContent.match(decodeFuncRegex);
  if (!funcMatch) {
    throw new Error('Decoder function pattern not found in player HTML.');
  }
  const fnName = funcMatch[1];

  const varMap = {};
  const varDeclRegex = /var\s+([a-zA-Z0-9_$]+)\s*=\s*['"]([^'"]*)['"]/g;
  let match;
  while ((match = varDeclRegex.exec(htmlContent)) !== null) {
    varMap[match[1]] = match[2];
  }

  const concatRegex = new RegExp(`var\\s+[a-zA-Z0-9_$]+\\s*=\\s*(?:${fnName}\\s*\\(\\s*[a-zA-Z0-9_$]+\\s*\\)\\s*\\+\\s*)*${fnName}\\s*\\(\\s*[a-zA-Z0-9_$]+\\s*\\)`, 'g');
  const concatMatch = htmlContent.match(concatRegex);
  if (!concatMatch) {
    throw new Error('URL concatenation line not found in player HTML.');
  }
  const concatExpression = concatMatch[0];

  const paramRegex = new RegExp(`${fnName}\\s*\\(\\s*([a-zA-Z0-9_$]+)\\s*\\)`, 'g');
  const resolvedParts = [];
  let paramMatch;
  while ((paramMatch = paramRegex.exec(concatExpression)) !== null) {
    const varName = paramMatch[1];
    const encodedVal = varMap[varName];
    if (encodedVal === undefined) {
      throw new Error(`Variable "${varName}" was requested but is not defined.`);
    }
    resolvedParts.push(decodeBase64(encodedVal));
  }

  const finalUrl = resolvedParts.join('');
  if (!finalUrl.startsWith('http')) {
    throw new Error(`Decoded URL does not look valid: "${finalUrl}"`);
  }
  return finalUrl;
}

async function handleLiveStream(request) {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  const code = url.searchParams.get('code');
  const user = url.searchParams.get('user') || 'cdnlivetv';
  const plan = url.searchParams.get('plan') || 'free';
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (!name || !code) {
    return errorResponse('Query parameters "name" and "code" are required', 400);
  }

  const cacheKey = `${name}_${code}_${user}_${plan}`;
  const now = Date.now();
  const cachedStream = memoryCache.streams.get(cacheKey);

  if (!forceRefresh && cachedStream && (now - cachedStream.timestamp < 3 * 60 * 1000)) {
    return jsonResponse({ success: true, cached: true, url: cachedStream.url });
  }

  try {
    const playerPageUrl = `https://cdnlivetv.tv/api/v1/channels/player/?name=${encodeURIComponent(name)}&code=${code}&user=${user}&plan=${plan}`;
    const res = await fetch(playerPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const htmlContent = await res.text();
    const streamUrl = resolveStreamUrl(htmlContent);

    memoryCache.streams.set(cacheKey, { url: streamUrl, timestamp: now });
    return jsonResponse({ success: true, cached: false, url: streamUrl });
  } catch (error) {
    console.error(`[Resolver] Failed to resolve stream for "${name}":`, error.message);
    return errorResponse(error.message || 'Failed to resolve stream URL', 500);
  }
}

// ══════════════════════════════════════════════════════════════
//  CLOUDFLARE WORKER MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    // 1. CORS Preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    try {
      // ════════════════════════════════════════════════════════
      //  ROUTE: Admin Panel UI (/admin, /344.html)
      // ════════════════════════════════════════════════════════
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/344.html') {
        const html = getAdminHtml();
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ...CORS_HEADERS,
          },
        });
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: data.json (Public / Cached)
      // ════════════════════════════════════════════════════════
      if (pathname === '/data.json' || pathname === '/api/data') {
        const data = await getDataJson(env);
        return jsonResponse(data);
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: GET /api/search
      // ════════════════════════════════════════════════════════
      if (pathname === '/api/search') {
        const q = url.searchParams.get('q');
        const type = url.searchParams.get('type') || 'multi';
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const mode = url.searchParams.get('mode') || 'search';

        if (!q || q.trim().length < 2) {
          return errorResponse('Query must be at least 2 characters.', 400);
        }

        const allowed = ['multi', 'movie', 'tv'];
        if (!allowed.includes(type)) {
          return errorResponse('type must be multi, movie, or tv.', 400);
        }

        let results = [];
        let total_pages = 1;
        let total_results = 0;

        if (mode === 'genre' || mode === 'language') {
          const genre = mode === 'genre' ? q : null;
          const lang = mode === 'language' ? q : null;

          if (type === 'multi') {
            const [movieData, tvData] = await Promise.all([
              discoverFetch('movie', genre, lang, page, env),
              discoverFetch('tv', genre, lang, page, env),
            ]);

            const movies = (movieData.results || []).map(item => ({ ...item, media_type: 'movie' }));
            const tvShows = (tvData.results || []).map(item => ({ ...item, media_type: 'tv' }));

            results = [...movies, ...tvShows].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            total_pages = Math.max(movieData.total_pages || 1, tvData.total_pages || 1);
            total_results = (movieData.total_results || 0) + (tvData.total_results || 0);
          } else {
            const data = await discoverFetch(type, genre, lang, page, env);
            results = (data.results || []).map(item => ({ ...item, media_type: type }));
            total_pages = data.total_pages || 1;
            total_results = data.total_results || 0;
          }
        } else {
          const data = await tmdbFetch(`/search/${type}`, { query: q.trim(), page }, env);
          results = (data.results || []).map(item => ({
            ...item,
            media_type: item.media_type || type,
          })).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
          total_pages = data.total_pages || 1;
          total_results = data.total_results || 0;
        }

        return jsonResponse({
          success: true,
          page,
          total_pages,
          total_results,
          results,
        });
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: GET /api/trending
      // ════════════════════════════════════════════════════════
      if (pathname === '/api/trending') {
        const type = url.searchParams.get('type') || 'all';
        const time = url.searchParams.get('time') || 'week';
        const data = await tmdbFetch(`/trending/${type}/${time}`, {}, env);
        return jsonResponse({ success: true, results: data.results || [] });
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: GET /api/details/:type/:id & GET /api/detail
      // ════════════════════════════════════════════════════════
      if (pathname.startsWith('/api/details/') || pathname === '/api/detail') {
        let type = '';
        let id = '';

        if (pathname === '/api/detail') {
          type = url.searchParams.get('type');
          id = url.searchParams.get('id');
        } else {
          const parts = pathname.replace('/api/details/', '').split('/');
          type = parts[0];
          id = parts[1];
        }

        if (!id) return errorResponse('id parameter is required.', 400);
        if (!['movie', 'tv'].includes(type)) return errorResponse('type must be movie or tv.', 400);

        const data = await getFullDetails(type, id, env);
        return jsonResponse({ success: true, data });
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: Continue Watching (ALL /api/continue-watching)
      // ════════════════════════════════════════════════════════
      if (pathname === '/api/continue-watching') {
        let items = [];
        let bodyJson = null;

        if (method === 'POST') {
          try {
            bodyJson = await request.json();
          } catch (e) {}
        }

        if (Array.isArray(bodyJson)) {
          items = bodyJson;
        } else if (bodyJson && Array.isArray(bodyJson.items)) {
          items = bodyJson.items;
        } else {
          const userId = url.searchParams.get('user_id') || (bodyJson && bodyJson.user_id);
          const authHeader = request.headers.get('Authorization') || (bodyJson && bodyJson.token ? `Bearer ${bodyJson.token}` : null);
          if (userId && authHeader) {
            const upstreamUrl = `https://testing-for-api.onrender.com/api/progress/${encodeURIComponent(userId)}`;
            const upstreamRes = await fetch(upstreamUrl, {
              headers: { 'Authorization': authHeader },
            });
            if (upstreamRes.ok) {
              items = await upstreamRes.json();
            } else {
              return errorResponse(`Failed to fetch upstream progress: ${upstreamRes.statusText}`, upstreamRes.status);
            }
          }
        }

        if (!Array.isArray(items) || items.length === 0) {
          return jsonResponse({ success: true, count: 0, results: [] });
        }

        const enrichedList = await Promise.all(items.map(async (item) => {
          const rawId = item.video_id;
          if (!rawId) return null;

          const rawType = String(item.media_type || 'movie').toLowerCase().trim();
          const mediaType = (rawType === 'tv' || rawType === 'shows' || rawType === 'series') ? 'tv' : 'movie';
          const seasonNumber = Number(item.season_number) || 0;
          const episodeNumber = Number(item.episode_number) || 0;
          const playbackMs = Number(item.playback_time_ms) || 0;
          let totalMs = Number(item.total_time_ms) || 0;

          let tmdbData = null;
          const cacheKey = `${mediaType}_${rawId}`;

          if (memoryCache.tmdb.has(cacheKey) && (Date.now() - memoryCache.tmdb.get(cacheKey).time < 30 * 60 * 1000)) {
            tmdbData = memoryCache.tmdb.get(cacheKey).data;
          } else {
            try {
              tmdbData = await tmdbFetch(`/${mediaType}/${rawId}`, {}, env);
              memoryCache.tmdb.set(cacheKey, { data: tmdbData, time: Date.now() });
            } catch (e) {
              console.warn(`[ContinueWatching] TMDB fetch failed for ${mediaType} ${rawId}:`, e.message);
            }
          }

          let episodeTitle = null;
          let episodeStill = null;
          if (mediaType === 'tv' && seasonNumber > 0 && episodeNumber > 0) {
            try {
              const epCacheKey = `ep_${rawId}_${seasonNumber}_${episodeNumber}`;
              let epData = null;
              if (memoryCache.tmdb.has(epCacheKey)) {
                epData = memoryCache.tmdb.get(epCacheKey).data;
              } else {
                epData = await tmdbFetch(`/tv/${rawId}/season/${seasonNumber}/episode/${episodeNumber}`, {}, env);
                memoryCache.tmdb.set(epCacheKey, { data: epData, time: Date.now() });
              }
              if (epData) {
                episodeTitle = epData.name;
                if (epData.still_path) {
                  episodeStill = `https://image.tmdb.org/t/p/w500${epData.still_path}`;
                }
              }
            } catch (e) {}
          }

          if (totalMs <= 0 && tmdbData) {
            const runtimeMins = tmdbData.runtime || (tmdbData.episode_run_time && tmdbData.episode_run_time[0]) || 60;
            totalMs = runtimeMins * 60 * 1000;
          }

          const title = (tmdbData && (tmdbData.title || tmdbData.name)) || `Title #${rawId}`;
          const poster = (tmdbData && tmdbData.poster_path)
            ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`
            : 'https://via.placeholder.com/500x750/1a1a2e/e8a020?text=No+Poster';
          const backdrop = (tmdbData && tmdbData.backdrop_path)
            ? `https://image.tmdb.org/t/p/w780${tmdbData.backdrop_path}`
            : poster;
          const thumbnail = episodeStill || backdrop || poster;
          const year = tmdbData ? (tmdbData.release_date || tmdbData.first_air_date || '').slice(0, 4) : '';
          const genres = (tmdbData && tmdbData.genres) ? tmdbData.genres.map(g => g.name).slice(0, 2) : [];

          const percentage = totalMs > 0 ? Math.min(100, Math.max(1, Math.round((playbackMs / totalMs) * 100))) : 0;
          const playbackSeconds = Math.floor(playbackMs / 1000);
          const totalSeconds = Math.floor(totalMs / 1000);

          const playUrl = mediaType === 'tv' && seasonNumber > 0
            ? `player.html?id=${rawId}&season=${seasonNumber}&episode=${episodeNumber}&time=${playbackSeconds}`
            : `player.html?id=${rawId}&time=${playbackSeconds}`;

          return {
            id: item.id || `cw_${rawId}`,
            videoId: rawId,
            tmdbId: rawId,
            mediaType,
            title,
            episodeTitle,
            seasonNumber,
            episodeNumber,
            poster,
            backdrop,
            thumbnail,
            year,
            genres,
            overview: (tmdbData && tmdbData.overview) || '',
            playbackTimeMs: playbackMs,
            totalTimeMs: totalMs,
            playbackSeconds,
            totalSeconds,
            percentage,
            timeWatched: formatDuration(playbackMs),
            timeRemaining: formatDuration(Math.max(0, totalMs - playbackMs)) + ' left',
            totalDuration: formatDuration(totalMs),
            playUrl,
            detailUrl: `detail.html?id=${rawId}&type=${mediaType}`,
            updatedAt: item.updated_at || item.created_at || new Date().toISOString(),
          };
        }));

        const validResults = enrichedList
          .filter(Boolean)
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        return jsonResponse({
          success: true,
          count: validResults.length,
          results: validResults,
        });
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: Live TV Channels & Stream Resolvers
      // ════════════════════════════════════════════════════════
      if (pathname === '/api/channels') {
        const user = url.searchParams.get('user') || 'cdnlivetv';
        const plan = url.searchParams.get('plan') || 'free';
        const forceRefresh = url.searchParams.get('refresh') === 'true';

        const now = Date.now();
        if (!forceRefresh && memoryCache.channels.data && (now - memoryCache.channels.timestamp < 10 * 60 * 1000)) {
          return jsonResponse({ success: true, cached: true, channels: memoryCache.channels.data });
        }

        try {
          const channelsUrl = `https://api.cdnlivetv.tv/api/v1/channels/?user=${user}&plan=${plan}`;
          const rawRes = await fetch(channelsUrl);
          const channelsList = await rawRes.json();

          memoryCache.channels.data = channelsList;
          memoryCache.channels.timestamp = now;

          return jsonResponse({ success: true, cached: false, channels: channelsList });
        } catch (error) {
          if (memoryCache.channels.data) {
            return jsonResponse({ success: true, cached: true, stale: true, channels: memoryCache.channels.data });
          }
          return errorResponse('Failed to retrieve channels list from CDN', 500);
        }
      }

      if (pathname === '/api/liveurl' || pathname === '/api/stream') {
        return await handleLiveStream(request);
      }

      // ════════════════════════════════════════════════════════
      //  ROUTE: POST & GET /api/play
      //  - Replaces peachify.top & video.json
      //  - Generates player.kineflex.site URL with Base64 Obfuscated Key
      // ════════════════════════════════════════════════════════
      if (pathname === '/api/play' || pathname === '/play') {
        let tmdbId = '';
        let mediaType = 'movie';
        let season = 1;
        let episode = 1;

        if (method === 'POST') {
          try {
            const body = await request.json();
            tmdbId = body.tmdb_id || body.id;
            mediaType = body.media_type || body.type || 'movie';
            season = body.season || body.season_number || 1;
            episode = body.episode || body.episode_number || 1;
            if (!tmdbId && body.tmdb_url) {
              const extracted = parseTMDBUrl(body.tmdb_url);
              if (extracted) {
                tmdbId = extracted.tmdb_id;
                mediaType = extracted.media_type;
              }
            }
          } catch (e) {}
        } else {
          tmdbId = url.searchParams.get('id') || url.searchParams.get('tmdb_id');
          mediaType = url.searchParams.get('type') || url.searchParams.get('media_type') || 'movie';
          season = url.searchParams.get('season') || url.searchParams.get('s') || url.searchParams.get('season_number') || 1;
          episode = url.searchParams.get('episode') || url.searchParams.get('e') || url.searchParams.get('episode_number') || 1;
          const tmdbUrlParam = url.searchParams.get('tmdb_url');
          if (!tmdbId && tmdbUrlParam) {
            const extracted = parseTMDBUrl(tmdbUrlParam);
            if (extracted) {
              tmdbId = extracted.tmdb_id;
              mediaType = extracted.media_type;
            }
          }
        }

        if (!tmdbId) {
          return errorResponse('tmdb_id (or valid id / tmdb_url) is required.', 400);
        }

        mediaType = String(mediaType).toLowerCase().trim() === 'tv' ? 'tv' : 'movie';

        // Retrieve active player API key from KV or env fallback
        const rawApiKey = await getPlayerApiKey(env);
        // Base64 encode the API key to hide plaintext key in the URL
        const encodedKey = btoa(rawApiKey);

        let playUrl = '';
        if (mediaType === 'movie') {
          playUrl = `https://player.kineflex.site/movie/${tmdbId}?key=${encodedKey}`;
        } else {
          playUrl = `https://player.kineflex.site/tv/${tmdbId}/${season}/${episode}?key=${encodedKey}`;
        }

        // Redirect directly if requested or accessed directly in browser
        if (url.searchParams.get('redirect') === 'true' && method === 'GET') {
          return Response.redirect(playUrl, 302);
        }

        return jsonResponse({
          success: true,
          url: playUrl,
          media_type: mediaType,
          tmdb_id: tmdbId,
          key_encoded: encodedKey,
        });
      }

      // ════════════════════════════════════════════════════════
      //  ADMIN API ENDPOINTS (Protected by X-Admin-Password)
      // ════════════════════════════════════════════════════════
      if (pathname.startsWith('/api/admin/')) {
        if (!checkAdminAuth(request, env)) {
          return jsonResponse({ success: false, message: 'Unauthorized: Invalid Admin Password' }, 401);
        }

        // List editable files (data.json only; video.json removed)
        if (pathname === '/api/admin/files' && method === 'GET') {
          return jsonResponse({ success: true, files: ['data.json'] });
        }

        // Read file contents (from Cloudflare KV or bundled fallback)
        if (pathname === '/api/admin/file' && method === 'GET') {
          const name = url.searchParams.get('name') || 'data.json';
          if (name !== 'data.json') {
            return errorResponse('Only data.json is editable in Cloudflare storage.', 400);
          }
          const content = await getDataJsonString(env);
          return jsonResponse({ success: true, content });
        }

        // Save file contents (to Cloudflare KV)
        if (pathname === '/api/admin/file' && method === 'POST') {
          const body = await request.json();
          const { name, content } = body || {};
          if (name !== 'data.json') {
            return errorResponse('Only data.json is editable in Cloudflare storage.', 400);
          }
          if (content === undefined || content === null) {
            return errorResponse('Content is required.', 400);
          }

          try {
            const saveResult = await saveDataJsonString(env, content);
            return jsonResponse({
              success: true,
              message: 'data.json saved to Cloudflare KV successfully.',
              ...saveResult,
            });
          } catch (err) {
            return errorResponse('Invalid JSON format: ' + err.message, 400);
          }
        }

        // Get Player Settings & API Key
        if (pathname === '/api/admin/settings' && method === 'GET') {
          const playerApiKey = await getPlayerApiKey(env);
          return jsonResponse({
            success: true,
            playerApiKey,
            playerApiKeyEncoded: btoa(playerApiKey),
            hasKv: !!env.KINFLEX_KV,
            storage: env.KINFLEX_KV ? 'cloudflare_kv' : 'fallback_memory',
          });
        }

        // Update Player Settings & API Key in Cloudflare KV
        if (pathname === '/api/admin/settings' && method === 'POST') {
          const body = await request.json();
          const { playerApiKey } = body || {};
          if (!playerApiKey || !playerApiKey.trim()) {
            return errorResponse('playerApiKey is required.', 400);
          }

          const saveResult = await setPlayerApiKey(env, playerApiKey);
          const encoded = btoa(playerApiKey.trim());

          return jsonResponse({
            success: true,
            message: 'Player API Key updated in Cloudflare KV successfully.',
            playerApiKey: playerApiKey.trim(),
            playerApiKeyEncoded: encoded,
            ...saveResult,
          });
        }
      }

      // ════════════════════════════════════════════════════════
      //  ROOT / STATUS FALLBACK
      // ════════════════════════════════════════════════════════
      if (pathname === '/' || pathname === '/status') {
        return new Response(
          `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kineflex API - Cloudflare Worker</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #06050b; color: #f3f4f6; margin: 0; padding: 40px 20px; line-height: 1.6; }
    .card { max-width: 650px; margin: 0 auto; background: #161323; border: 1px solid rgba(232,160,32,0.2); border-radius: 12px; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
    h1 { color: #e8a020; margin-top: 0; font-size: 1.8rem; }
    .badge { display: inline-block; background: rgba(16,185,129,0.2); color: #10b981; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; margin-bottom: 16px; }
    a { color: #e8a020; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    .btn { display: inline-block; background: #e8a020; color: #000; padding: 10px 18px; border-radius: 8px; font-weight: 600; text-decoration: none; margin-top: 16px; margin-right: 10px; }
    .btn:hover { background: #f3b139; text-decoration: none; }
    ul { padding-left: 20px; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Cloudflare Worker Live</div>
    <h1>Kineflex Backend</h1>
    <p>Modern streaming API powered by Cloudflare Workers & Cloudflare KV storage.</p>
    <ul>
      <li><strong>Streaming Player:</strong> <code>player.kineflex.site</code> (Base64 Key Obfuscation)</li>
      <li><strong>Data Storage:</strong> Cloudflare KV (<code>data.json</code>)</li>
      <li><strong>Admin Dashboard:</strong> <a href="/admin">/admin</a> or <a href="/344.html">/344.html</a></li>
      <li><strong>Data Catalog:</strong> <a href="/data.json">/data.json</a></li>
    </ul>
    <a href="/admin" class="btn">Open Admin Dashboard</a>
    <a href="/data.json" class="btn" style="background: rgba(255,255,255,0.1); color: #fff;">View data.json</a>
  </div>
</body>
</html>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
          }
        );
      }

      // 404 for unknown routes
      return errorResponse(`Route not found: ${pathname}`, 404);
    } catch (err) {
      console.error('[Worker Error]', err);
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};
