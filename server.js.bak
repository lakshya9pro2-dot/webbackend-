const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── TMDB API key lives ONLY here, never sent to the browser ───
const TMDB_KEY  = process.env.TMDB_KEY || 'e6333b32409e02a4a6eba6fb7ff866bb';
const TMDB_BASE = 'https://api.themoviedb.org/3';

app.use(cors());
app.use(express.json());
// serves static assets from 'main website' (if present) and 'public'
const mainWebDir = path.join(__dirname, 'main website');
if (fs.existsSync(mainWebDir)) {
    app.use(express.static(mainWebDir));
}
app.use(express.static(path.join(__dirname, 'public')));


// ══════════════════════════════════════════════════════════════
//  HELPER — forward a TMDB fetch to the client
// ══════════════════════════════════════════════════════════════
async function tmdbFetch(path, extraParams = {}) {
    const url = new URL(`${TMDB_BASE}${path}`);
    url.searchParams.set('api_key', TMDB_KEY);
    url.searchParams.set('include_adult', 'false');
    for (const [k, v] of Object.entries(extraParams)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`TMDB ${res.status}: ${err}`);
    }
    return res.json();
}

// ══════════════════════════════════════════════════════════════
//  HELPERS — discover maps and fetchers
// ══════════════════════════════════════════════════════════════
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
    const name = genreName.toLowerCase().trim();
    if (mediaType === 'tv') {
        if (name === 'action') return 10759; // Action & Adventure
        if (name === 'sci-fi') return 10765; // Sci-Fi & Fantasy
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

async function discoverFetch(type, genre, lang, page) {
    const params = { page };
    if (genre) {
        const genreId = getGenreId(genre, type);
        if (genreId) params.with_genres = genreId;
    }
    if (lang) {
        const langCode = LANG_MAP[lang.toLowerCase().trim()];
        if (langCode) params.with_original_language = langCode;
    }
    return tmdbFetch(`/discover/${type}`, params);
}

// ══════════════════════════════════════════════════════════════
//  HELPER — parse a TMDB URL into { tmdb_id, media_type }
// ══════════════════════════════════════════════════════════════
function parseTMDBUrl(url) {
    if (!url) return null;
    let match = url.match(/themoviedb\.org\/movie\/(\d+)/i);
    if (match) return { tmdb_id: match[1], media_type: 'movie' };
    match = url.match(/themoviedb\.org\/tv\/(\d+)/i);
    if (match) return { tmdb_id: match[1], media_type: 'tv' };
    return null;
}

// ══════════════════════════════════════════════════════════════
//  GET /api/search?q=batman&type=multi|movie|tv&page=1
//  Proxies TMDB search so the API key never leaves the server.
// ══════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
    const { q, type = 'multi', page = 1, mode = 'search' } = req.query;

    if (!q || q.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
    }

    const allowed = ['multi', 'movie', 'tv'];
    if (!allowed.includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be multi, movie, or tv.' });
    }

    try {
        let results = [];
        let total_pages = 1;
        let total_results = 0;

        if (mode === 'genre' || mode === 'language') {
            const genre = mode === 'genre' ? q : null;
            const lang = mode === 'language' ? q : null;

            if (type === 'multi') {
                const [movieData, tvData] = await Promise.all([
                    discoverFetch('movie', genre, lang, page),
                    discoverFetch('tv', genre, lang, page)
                ]);

                const movies = (movieData.results || []).map(item => ({ ...item, media_type: 'movie' }));
                const tvShows = (tvData.results || []).map(item => ({ ...item, media_type: 'tv' }));
                
                results = [...movies, ...tvShows].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
                total_pages = Math.max(movieData.total_pages || 1, tvData.total_pages || 1);
                total_results = (movieData.total_results || 0) + (tvData.total_results || 0);
            } else {
                const data = await discoverFetch(type, genre, lang, page);
                results = (data.results || []).map(item => ({
                    ...item,
                    media_type: type
                }));
                total_pages = data.total_pages;
                total_results = data.total_results;
            }
        } else {
            const data = await tmdbFetch(`/search/${type}`, { query: q.trim(), page });
            results = (data.results || []).map(item => ({
                ...item,
                media_type: item.media_type || type,
            })).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
            total_pages = data.total_pages;
            total_results = data.total_results;
        }

        res.json({
            success:      true,
            page:         parseInt(page),
            total_pages,
            total_results,
            results,
        });
    } catch (err) {
        console.error('[/api/search]', err.message);
        res.status(502).json({ success: false, message: 'TMDB search/discover failed.', error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/trending?type=movie|tv|all&time=day|week
//  Optional — lets the frontend load trending content server-side
// ══════════════════════════════════════════════════════════════
app.get('/api/trending', async (req, res) => {
    const { type = 'all', time = 'week' } = req.query;
    try {
        const data = await tmdbFetch(`/trending/${type}/${time}`);
        res.json({ success: true, results: data.results || [] });
    } catch (err) {
        console.error('[/api/trending]', err.message);
        res.status(502).json({ success: false, message: 'TMDB trending failed.', error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  HELPER — fetch TV season episodes
// ══════════════════════════════════════════════════════════════
async function getSeasonEpisodes(tvId, seasonNumber) {
    try {
        const data = await tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`);
        return (data.episodes || []).map(ep => ({
            id: ep.id,
            name: ep.name,
            overview: ep.overview,
            episodeNumber: ep.episode_number,
            seasonNumber: ep.season_number,
            airDate: ep.air_date,
            still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : 'https://via.placeholder.com/300x169/1a1a2e/e8a020?text=No+Image',
            rating: ep.vote_average ? parseFloat(ep.vote_average.toFixed(1)) : 0,
            voteCount: ep.vote_count || 0
        }));
    } catch (err) {
        console.error(`Failed to fetch episodes for TV Show ${tvId} Season ${seasonNumber}:`, err.message);
        return [];
    }
}

// ══════════════════════════════════════════════════════════════
//  HELPER — get full structured details from TMDB
// ══════════════════════════════════════════════════════════════
async function getFullDetails(type, id) {
    const appendToResponse = type === 'movie' 
        ? 'credits,videos,release_dates,similar' 
        : 'credits,videos,content_ratings,similar';
        
    const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: appendToResponse });

    // Parse certifications
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
            photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : 'https://via.placeholder.com/185x278/1a1a2e/e8a020?text=No+Photo'
        }));
        crew = crewList.map(c => ({
            name: c.name,
            job: c.job,
            department: c.department
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
                key: v.key
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
            year: (s.release_date || s.first_air_date || '').slice(0, 4)
        }));
    }

    // Seasons (TV Only)
    let seasons = [];
    if (type === 'tv' && data.seasons) {
        // Filter out "Specials" (season_number === 0)
        const activeSeasons = data.seasons.filter(s => s.season_number > 0);
        seasons = await Promise.all(activeSeasons.map(async (s) => {
            const episodes = await getSeasonEpisodes(id, s.season_number);
            return {
                id: s.id,
                name: s.name,
                seasonNumber: s.season_number,
                episodeCount: s.episode_count,
                poster: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : 'https://via.placeholder.com/342x513/1a1a2e/e8a020?text=No+Image',
                overview: s.overview || '',
                airDate: s.air_date || '',
                episodes
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
        seasons
    };
}

// ══════════════════════════════════════════════════════════════
//  GET /api/details/:type/:id
//  Returns enriched TMDB details for a movie or TV show
// ══════════════════════════════════════════════════════════════
app.get('/api/details/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!['movie', 'tv'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be movie or tv.' });
    }
    try {
        const data = await getFullDetails(type, id);
        res.json({ success: true, data });
    } catch (err) {
        console.error('[/api/details]', err.message);
        res.status(502).json({ success: false, message: 'TMDB details failed.', error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/detail?id=...&type=...
//  Alternative query parameter route to fetch details
// ══════════════════════════════════════════════════════════════
app.get('/api/detail', async (req, res) => {
    const { id, type } = req.query;
    if (!id) {
        return res.status(400).json({ success: false, message: 'id parameter is required.' });
    }
    if (!type || !['movie', 'tv'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type parameter must be movie or tv.' });
    }
    try {
        const data = await getFullDetails(type, id);
        res.json({ success: true, data });
    } catch (err) {
        console.error('[/api/detail]', err.message);
        res.status(502).json({ success: false, message: 'TMDB details failed.', error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  POST & GET /api/continue-watching
//  Enriches watching progress with TMDB metadata, time & progress %
// ══════════════════════════════════════════════════════════════
app.all('/api/continue-watching', async (req, res) => {
    try {
        let items = [];

        // 1. Accept items from POST body (array or { items: [...] })
        if (Array.isArray(req.body)) {
            items = req.body;
        } else if (req.body && Array.isArray(req.body.items)) {
            items = req.body.items;
        } else {
            // 2. Or fetch directly from testing-for-api if user_id and token provided
            const userId = req.query.user_id || (req.body && req.body.user_id);
            const authHeader = req.headers.authorization || (req.body && req.body.token ? `Bearer ${req.body.token}` : null);

            if (userId && authHeader) {
                const upstreamUrl = `https://testing-for-api.onrender.com/api/progress/${encodeURIComponent(userId)}`;
                const upstreamRes = await fetch(upstreamUrl, {
                    headers: { 'Authorization': authHeader }
                });
                if (upstreamRes.ok) {
                    items = await upstreamRes.json();
                } else {
                    return res.status(upstreamRes.status).json({
                        success: false,
                        message: `Failed to fetch progress from upstream: ${upstreamRes.statusText}`
                    });
                }
            }
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.json({ success: true, count: 0, results: [] });
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

        if (!cache.tmdb) cache.tmdb = new Map();

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

            if (cache.tmdb.has(cacheKey) && (Date.now() - cache.tmdb.get(cacheKey).time < 30 * 60 * 1000)) {
                tmdbData = cache.tmdb.get(cacheKey).data;
            } else {
                try {
                    tmdbData = await tmdbFetch(`/${mediaType}/${rawId}`);
                    cache.tmdb.set(cacheKey, { data: tmdbData, time: Date.now() });
                } catch (e) {
                    console.warn(`[ContinueWatching] TMDB fetch failed for ${mediaType} ${rawId}:`, e.message);
                }
            }

            // Fallback to local video.json or data.json if TMDB not found
            let localMatch = null;
            if (!tmdbData) {
                try {
                    const videoJsonPath = path.join(__dirname, 'public', 'video.json');
                    const mainVideoPath = path.join(__dirname, 'main website', 'video.json');
                    const vPath = fs.existsSync(mainVideoPath) ? mainVideoPath : videoJsonPath;
                    if (fs.existsSync(vPath)) {
                        const vList = JSON.parse(fs.readFileSync(vPath, 'utf8'));
                        localMatch = vList.find(v => String(v.id) === String(rawId));
                    }
                } catch (err) {}
            }

            // Episode info for TV shows
            let episodeTitle = null;
            let episodeStill = null;
            if (mediaType === 'tv' && seasonNumber > 0 && episodeNumber > 0) {
                try {
                    const epCacheKey = `ep_${rawId}_${seasonNumber}_${episodeNumber}`;
                    let epData = null;
                    if (cache.tmdb.has(epCacheKey)) {
                        epData = cache.tmdb.get(epCacheKey).data;
                    } else {
                        epData = await tmdbFetch(`/tv/${rawId}/season/${seasonNumber}/episode/${episodeNumber}`);
                        cache.tmdb.set(epCacheKey, { data: epData, time: Date.now() });
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

            const title = (tmdbData && (tmdbData.title || tmdbData.name)) || (localMatch && localMatch.title) || `Title #${rawId}`;
            const poster = (tmdbData && tmdbData.poster_path) ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : (localMatch && (localMatch.poster || localMatch.thumbnail)) || 'https://via.placeholder.com/500x750/1a1a2e/e8a020?text=No+Poster';
            const backdrop = (tmdbData && tmdbData.backdrop_path) ? `https://image.tmdb.org/t/p/w780${tmdbData.backdrop_path}` : poster;
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
                updatedAt: item.updated_at || item.created_at || new Date().toISOString()
            };
        }));

        const validResults = enrichedList
            .filter(Boolean)
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        res.json({
            success: true,
            count: validResults.length,
            results: validResults
        });
    } catch (err) {
        console.error('[/api/continue-watching]', err);
        res.status(500).json({ success: false, message: 'Failed to resolve continue watching details', error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  LIVE TV STREAM RESOLVER HELPERS & ENDPOINTS
// ══════════════════════════════════════════════════════════════
const cache = {
    channels: {
        data: null,
        timestamp: 0,
    },
    streams: new Map(), // key: 'name_code_user_plan', value: { url, timestamp }
};

const CACHE_DURATION_CHANNELS = 10 * 60 * 1000; // 10 minutes
const CACHE_DURATION_STREAMS = 3 * 60 * 1000;  // 3 minutes (tokens expire, keep short)

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        };
        const req = https.get(url, options, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const parsedUrl = new URL(url);
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                }
                console.log(`[HTTP] Redirecting to: ${redirectUrl}`);
                return httpGet(redirectUrl).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => { resolve(data); });
        });
        req.on('error', (err) => { reject(err); });
    });
}

function decodeBase64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) {
        s += '=';
    }
    try {
        return Buffer.from(s, 'base64').toString('utf8');
    } catch (e) {
        return Buffer.from(s, 'base64').toString('binary');
    }
}

function resolveStreamUrl(htmlContent) {
    // 1. Find the obfuscated decoder function name
    const decodeFuncRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(s\)\s*\{\s*s\s*=\s*s\.replace/;
    const funcMatch = htmlContent.match(decodeFuncRegex);
    if (!funcMatch) {
        throw new Error("Decoder function pattern not found in player HTML. The site may have changed its protection mechanism.");
    }
    const fnName = funcMatch[1];
    console.log(`[Resolver] Detected decoder function name: "${fnName}"`);

    // 2. Map all variables inside the script block
    const varMap = {};
    const varDeclRegex = /var\s+([a-zA-Z0-9_$]+)\s*=\s*['"]([^'"]*)['"]/g;
    let match;
    while ((match = varDeclRegex.exec(htmlContent)) !== null) {
        varMap[match[1]] = match[2];
    }

    // 3. Extract the concatenation line that decodes variables and joins them
    const concatRegex = new RegExp(`var\\s+[a-zA-Z0-9_$]+\\s*=\\s*(?:${fnName}\\s*\\(\\s*[a-zA-Z0-9_$]+\\s*\\)\\s*\\+\\s*)*${fnName}\\s*\\(\\s*[a-zA-Z0-9_$]+\\s*\\)`, 'g');
    const concatMatch = htmlContent.match(concatRegex);
    if (!concatMatch) {
        throw new Error("URL concatenation line not found in player HTML.");
    }
    const concatExpression = concatMatch[0];
    console.log(`[Resolver] Found concatenation pattern: "${concatExpression}"`);

    // 4. Decode each variable in order
    const paramRegex = new RegExp(`${fnName}\\s*\\(\\s*([a-zA-Z0-9_$]+)\\s*\\)`, 'g');
    const resolvedParts = [];
    let paramMatch;
    while ((paramMatch = paramRegex.exec(concatExpression)) !== null) {
        const varName = paramMatch[1];
        const encodedVal = varMap[varName];
        if (encodedVal === undefined) {
            throw new Error(`Variable "${varName}" was requested but is not defined in the source script.`);
        }
        const decodedVal = decodeBase64(encodedVal);
        resolvedParts.push(decodedVal);
    }

    const finalUrl = resolvedParts.join('');
    if (!finalUrl.startsWith('http')) {
        throw new Error(`Decoded URL does not look valid: "${finalUrl}"`);
    }
    return finalUrl;
}

/**
 * Route: List channels from API
 */
app.get('/api/channels', async (req, res) => {
    const user = req.query.user || 'cdnlivetv';
    const plan = req.query.plan || 'free';
    const forceRefresh = req.query.refresh === 'true';

    const now = Date.now();
    if (!forceRefresh && cache.channels.data && (now - cache.channels.timestamp < CACHE_DURATION_CHANNELS)) {
        console.log('[Cache] Serving channels list from cache');
        return res.json({ success: true, cached: true, channels: cache.channels.data });
    }

    try {
        const channelsUrl = `https://api.cdnlivetv.tv/api/v1/channels/?user=${user}&plan=${plan}`;
        console.log(`[API] Fetching channels from: ${channelsUrl}`);
        const rawData = await httpGet(channelsUrl);
        const channelsList = JSON.parse(rawData);

        cache.channels.data = channelsList;
        cache.channels.timestamp = now;

        res.json({ success: true, cached: false, channels: channelsList });
    } catch (error) {
        console.error('[API] Error retrieving channels:', error.message);
        if (cache.channels.data) {
            console.log('[Cache] Returning stale cache due to fetch failure');
            return res.json({ success: true, cached: true, stale: true, channels: cache.channels.data });
        }
        res.status(500).json({ success: false, error: 'Failed to retrieve channels list from CDN' });
    }
});

/**
 * Route: Resolve stream URL for a channel
 */
async function handleLiveStream(req, res) {
    const { name, code } = req.query;
    const user = req.query.user || 'cdnlivetv';
    const plan = req.query.plan || 'free';
    const forceRefresh = req.query.refresh === 'true';

    if (!name || !code) {
        return res.status(400).json({ success: false, error: 'Query parameters "name" and "code" are required' });
    }

    const cacheKey = `${name}_${code}_${user}_${plan}`;
    const now = Date.now();
    const cachedStream = cache.streams.get(cacheKey);

    if (!forceRefresh && cachedStream && (now - cachedStream.timestamp < CACHE_DURATION_STREAMS)) {
        console.log(`[Cache] Serving stream URL for "${name}" from cache`);
        return res.json({ success: true, cached: true, url: cachedStream.url });
    }

    try {
        const playerPageUrl = `https://cdnlivetv.tv/api/v1/channels/player/?name=${encodeURIComponent(name)}&code=${code}&user=${user}&plan=${plan}`;
        console.log(`[API] Resolving player page: ${playerPageUrl}`);
        const htmlContent = await httpGet(playerPageUrl);
        const streamUrl = resolveStreamUrl(htmlContent);

        cache.streams.set(cacheKey, { url: streamUrl, timestamp: now });
        console.log(`[Resolver] Successfully resolved and cached stream URL for "${name}"`);

        res.json({ success: true, cached: false, url: streamUrl });
    } catch (error) {
        console.error(`[Resolver] Failed to resolve stream for "${name}":`, error.message);
        res.status(500).json({ success: false, error: error.message || 'Failed to resolve stream URL' });
    }
}

app.get('/api/liveurl', handleLiveStream);
app.get('/api/stream', handleLiveStream);

// ══════════════════════════════════════════════════════════════
//  GET /api/url
//  Resolves turbovidhls video source variables (urlPlay, urlSub, poster)
//  Completely refactored for fault-tolerance based on provided HTML
// ══════════════════════════════════════════════════════════════
app.get('/api/url', async (req, res) => {
    const { id } = req.query;
    if (!id) {
        return res.status(400).json({ success: false, message: 'id parameter is required.' });
    }

    try {
        let code = id;
        const videoJsonPath = path.join(__dirname, 'public', 'video.json');
        if (fs.existsSync(videoJsonPath)) {
            const videoData = JSON.parse(fs.readFileSync(videoJsonPath, 'utf8'));
            const matchedVideo = videoData.find(v => String(v.id) === String(id));
            if (matchedVideo && matchedVideo.play) {
                code = matchedVideo.play;
            }
        }

        const targetUrl = `https://turbovidhls.com/t/${code}`;
        console.log(`[/api/url] Scraping target: ${targetUrl}`);
        
        const fetchRes = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://turbovidhls.com/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            }
        });
        
        if (!fetchRes.ok) {
            return res.status(502).json({ success: false, message: `Failed to fetch from turbovidhls: ${fetchRes.statusText} (${fetchRes.status})` });
        }
        
        const html = await fetchRes.text();

        // Check if Cloudflare or similar WAF is blocking the backend fetch request
        if (html.includes('Just a moment...') || html.includes('cloudflare-core')) {
            console.error('[/api/url] Blocked by Cloudflare JS challenge!');
            return res.status(403).json({ success: false, message: 'The video provider is currently blocking server requests (Cloudflare Challenge).' });
        }

        let urlPlay = '';
        let urlSub = '';
        let posterUrl = '';

        // 1. Extract urlPlay (e.g., var urlPlay = 'https://...');
        const urlPlayMatch = html.match(/urlPlay\s*=\s*['"]([^'"]+)['"]/i);
        if (urlPlayMatch) urlPlay = urlPlayMatch[1];

        // 2. Extract urlSub
        const urlSubMatch  = html.match(/urlSub\s*=\s*['"]([^'"]+)['"]/i);
        if (urlSubMatch) urlSub = urlSubMatch[1];

        // 3. Extract poster (Handles ternary operators like: var poster = "no"=="no" ? 'URL' : 'URL';)
        const posterMatch = html.match(/poster\s*=\s*[^']*'([^']+)'/i);
        if (posterMatch) posterUrl = posterMatch[1];

        // 4. NUCLEAR FALLBACK: If standard extraction fails, literally find the first .m3u8 link in the HTML
        if (!urlPlay) {
            console.warn(`[/api/url] Standard variable extraction failed. Scanning full HTML for .m3u8...`);
            const m3u8FallbackMatch = html.match(/(https?:\/\/[a-zA-Z0-9_.\/-]+\.m3u8[^'"]*)/i);
            if (m3u8FallbackMatch) {
                urlPlay = m3u8FallbackMatch[1];
            }
        }

        console.log(`[/api/url] Resolved TMDB:${id} (code:${code})`);
        console.log(` -> urlPlay: ${urlPlay ? urlPlay.substring(0, 50) + '...' : 'Not Found'}`);

        if (!urlPlay) {
            return res.status(404).json({ success: false, message: 'Could not extract video URLs. The provider may have changed their layout.' });
        }

        res.json({
            success: true,
            code,
            urlPlay,
            urlSub,
            poster: posterUrl
        });
    } catch (err) {
        console.error('[/api/url]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/play
//  Builds the Peachify embed URL and returns it to the frontend.
//  Body: { tmdb_id, media_type, season?, episode?, dub?, sub?, tmdb_url? }
// ══════════════════════════════════════════════════════════════
app.post('/api/play', (req, res) => {
    let { tmdb_id, media_type, season, episode, season_number, episode_number, dub, sub, tmdb_url } = req.body;

    // Fallback: extract IDs from a full TMDB URL if raw ID not provided
    if (!tmdb_id && tmdb_url) {
        const extracted = parseTMDBUrl(tmdb_url);
        if (extracted) {
            tmdb_id    = extracted.tmdb_id;
            media_type = extracted.media_type;
        }
    }

    if (!tmdb_id || !media_type) {
        return res.status(400).json({
            success: false,
            message: 'tmdb_id (or valid tmdb_url) and media_type are required.',
        });
    }

    // Search public/video.json for matching id
    try {
        const videoJsonPath = path.join(__dirname, 'public', 'video.json');
        if (fs.existsSync(videoJsonPath)) {
            const videoData = JSON.parse(fs.readFileSync(videoJsonPath, 'utf8'));
            const matchedVideo = videoData.find(v => String(v.id) === String(tmdb_id));
            if (matchedVideo) {
                return res.json({ success: true, url: `player.html?id=${tmdb_id}` });
            }
        }
    } catch (err) {
        console.error('Error reading video.json in /api/play:', err.message);
    }

    const dubParam = dub  || 'hindi';
    const subParam = sub  || 'eng';
    const query    = `?dub=${dubParam}&sub=${subParam}`;

    let playUrl = '';
    if (media_type === 'movie') {
        playUrl = `https://peachify.top/embed/movie/${tmdb_id}${query}`;
    } else if (media_type === 'tv') {
        const s = season || season_number || 1;
        const e = episode || episode_number || 1;
        playUrl = `https://peachify.top/embed/tv/${tmdb_id}/${s}/${e}${query}`;
    } else {
        return res.status(400).json({ success: false, message: 'Invalid media_type. Use "movie" or "tv".' });
    }

    console.log(`[/api/play] ${media_type} → TMDB:${tmdb_id} → ${playUrl}`);
    res.json({ success: true, url: playUrl });
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS FOR JSON EDITING AND SAVING (PASSWORD PROTECTED)
// ══════════════════════════════════════════════════════════════

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '9310081539';

function checkAdminAuth(req, res, next) {
    const pwd = req.headers['x-admin-password'];
    if (pwd === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized: Invalid Admin Password' });
    }
}

// List editable files
app.get('/api/admin/files', checkAdminAuth, (req, res) => {
    const files = ['data.json', 'video.json'];
    res.json({ success: true, files });
});

// Read file contents
app.get('/api/admin/file', checkAdminAuth, (req, res) => {
    const { name } = req.query;
    if (!name || !['data.json', 'video.json'].includes(name)) {
        return res.status(400).json({ success: false, message: 'Invalid file name. Only data.json and video.json are editable.' });
    }
    const filePath = path.join(__dirname, 'public', name);
    try {
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }
        const data = fs.readFileSync(filePath, 'utf8');
        res.json({ success: true, content: data });
    } catch (err) {
        console.error(`[Admin GET /api/admin/file] Error:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Save file contents
app.post('/api/admin/file', checkAdminAuth, (req, res) => {
    const { name, content } = req.body;
    if (!name || !['data.json', 'video.json'].includes(name)) {
        return res.status(400).json({ success: false, message: 'Invalid file name. Only data.json and video.json are editable.' });
    }
    if (content === undefined || content === null) {
        return res.status(400).json({ success: false, message: 'Content is required.' });
    }

    // Validate JSON structure before saving
    try {
        JSON.parse(content);
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Invalid JSON format: ' + err.message });
    }

    const filePath = path.join(__dirname, 'public', name);
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`[Admin POST /api/admin/file] Saved ${name} successfully.`);
        res.json({ success: true, message: `${name} saved successfully.` });
    } catch (err) {
        console.error(`[Admin POST /api/admin/file] Error writing file:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  404 fallback — serve the SPA for any unmatched GET
// ══════════════════════════════════════════════════════════════
app.get(/.*/, (req, res) => {
    const mainIndex = path.join(__dirname, 'main website', 'index.html');
    if (fs.existsSync(mainIndex)) {
        return res.sendFile(mainIndex);
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`KineflixTV server running → http://localhost:${PORT}`);
});