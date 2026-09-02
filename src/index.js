const express = require('express');
const fetch = require('node-fetch');

/**
 * Jellyfin sidecar. Auth: API key from Dashboard → API Keys, sent as
 * `X-Emby-Token` header. Most item calls are user-scoped because watch state
 * / parental filters change per user; we default to JELLYFIN_USER_ID when the
 * caller doesn't pass one.
 *
 * Coverage: 30 read tools — items/library (7), users (4), sessions/playback
 * (4), media by type (5), metadata (3), collections/playlists (3), system (4).
 * Combined with Pro (25) = 55 per Plugin Tool Coverage Standard v1.
 */
function baseUrl() {
  const u = process.env.JELLYFIN_BASE_URL;
  if (!u) throw new Error('JELLYFIN_BASE_URL not set');
  return u.replace(/\/$/, '');
}
function authHeader() {
  const t = process.env.JELLYFIN_TOKEN;
  if (!t) throw new Error('JELLYFIN_TOKEN not set');
  return { 'X-Emby-Token': t };
}
function defaultUserId() {
  return process.env.JELLYFIN_USER_ID || null;
}
async function jf(path, opts = {}) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { ...authHeader(), 'Content-Type': 'application/json', 'Accept': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.message || text || `Jellyfin ${res.status}`);
    err.statusCode = res.status;
    err.code = 'jellyfin_error';
    throw err;
  }
  return json;
}
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) q.set(k, v.join(','));
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

const tools = [
  // ── Items / Library (7) ───────────────────────────────────────────
  {
    name: 'jellyfin.getItems',
    description: 'Query the Jellyfin library with filters (IncludeItemTypes, ParentId, SearchTerm, ...).',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        parentId: { type: 'string' },
        includeItemTypes: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Movie","Series"]' },
        excludeItemTypes: { type: 'array', items: { type: 'string' } },
        searchTerm: { type: 'string' },
        genres: { type: 'array', items: { type: 'string' } },
        years: { type: 'array', items: { type: 'integer' } },
        isFavorite: { type: 'boolean' },
        limit: { type: 'integer' },
        startIndex: { type: 'integer' },
        recursive: { type: 'boolean' },
        sortBy: { type: 'string' },
        sortOrder: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ ...p, userId: undefined })}`);
    },
  },
  {
    name: 'jellyfin.getItem',
    description: 'Fetch a single item (with per-user data if userId provided).',
    input_schema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const path = userId ? `/Users/${userId}/Items/${p.id}` : `/Items/${p.id}`;
      return jf(path);
    },
  },
  {
    name: 'jellyfin.searchHints',
    description: 'Server-side search — full-text over titles, people, tags.',
    input_schema: {
      type: 'object', required: ['searchTerm'],
      properties: {
        searchTerm: { type: 'string' },
        userId: { type: 'string' },
        includeItemTypes: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Search/Hints${qs({ ...p, userId })}`);
    },
  },
  {
    name: 'jellyfin.getLatestMedia',
    description: 'Most recently added items for a user.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        parentId: { type: 'string' },
        includeItemTypes: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (!userId) throw new Error('userId required');
      return jf(`/Users/${userId}/Items/Latest${qs({ ...p, userId: undefined })}`);
    },
  },
  {
    name: 'jellyfin.getResumeItems',
    description: 'Continue-watching queue for a user.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        limit: { type: 'integer' },
        includeItemTypes: { type: 'array', items: { type: 'string' } },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (!userId) throw new Error('userId required');
      return jf(`/Users/${userId}/Items/Resume${qs({ ...p, userId: undefined })}`);
    },
  },
  {
    name: 'jellyfin.getFavorites',
    description: 'Convenience: favorite items for a user.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        includeItemTypes: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (!userId) throw new Error('userId required');
      return jf(`/Users/${userId}/Items${qs({ ...p, userId: undefined, isFavorite: true, recursive: true })}`);
    },
  },
  {
    name: 'jellyfin.getSuggestions',
    description: 'AI-suggested items for a user.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        limit: { type: 'integer' },
        mediaType: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (!userId) throw new Error('userId required');
      return jf(`/Users/${userId}/Suggestions${qs({ ...p, userId: undefined })}`);
    },
  },

  // ── Users (4) ────────────────────────────────────────────────────
  {
    name: 'jellyfin.getUsers',
    description: 'List all Jellyfin users.',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Users'),
  },
  {
    name: 'jellyfin.getUser',
    description: 'Fetch a single user profile.',
    input_schema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' } },
    },
    required_scope: 'read',
    handler: async (p) => jf(`/Users/${p.id}`),
  },
  {
    name: 'jellyfin.getMe',
    description: 'Current user profile (based on the token). Falls back to JELLYFIN_USER_ID.',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => {
      // Jellyfin exposes /Users/Me only with user-auth tokens; API keys use /Users
      const uid = defaultUserId();
      if (!uid) throw new Error('JELLYFIN_USER_ID not set — cannot resolve current user via API key');
      return jf(`/Users/${uid}`);
    },
  },
  {
    name: 'jellyfin.getUserViews',
    description: 'Libraries visible to a user (Movies, Shows, Music, etc).',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (!userId) throw new Error('userId required');
      return jf(`/Users/${userId}/Views`);
    },
  },

  // ── Sessions / Playback (4) ──────────────────────────────────────
  {
    name: 'jellyfin.getSessions',
    description: 'All active sessions (clients connected to the server).',
    input_schema: {
      type: 'object',
      properties: {
        controllableByUserId: { type: 'string' },
        deviceId: { type: 'string' },
        activeWithinSeconds: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => jf(`/Sessions${qs(p)}`),
  },
  {
    name: 'jellyfin.getNowPlaying',
    description: 'Convenience: sessions currently playing something.',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => {
      const all = await jf('/Sessions');
      return Array.isArray(all) ? all.filter(s => s.NowPlayingItem) : [];
    },
  },
  {
    name: 'jellyfin.getPlaybackInfo',
    description: 'Playable stream info + media sources for an item.',
    input_schema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Items/${p.id}/PlaybackInfo${qs({ userId })}`);
    },
  },
  {
    name: 'jellyfin.getSimilarItems',
    description: 'Items similar to a given one (used for recommendations).',
    input_schema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Items/${p.id}/Similar${qs({ userId, limit: p.limit })}`);
    },
  },

  // ── Media types (5) — convenience filters ────────────────────────
  {
    name: 'jellyfin.getMovies',
    description: 'Convenience: Movie items across libraries.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        limit: { type: 'integer' },
        sortBy: { type: 'string' },
        genres: { type: 'array', items: { type: 'string' } },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ ...p, userId: undefined, includeItemTypes: 'Movie', recursive: true })}`);
    },
  },
  {
    name: 'jellyfin.getSeries',
    description: 'Convenience: TV Series items.',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' }, limit: { type: 'integer' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ ...p, userId: undefined, includeItemTypes: 'Series', recursive: true })}`);
    },
  },
  {
    name: 'jellyfin.getEpisodes',
    description: 'Episodes of a series (or all episodes across libraries).',
    input_schema: {
      type: 'object',
      properties: {
        seriesId: { type: 'string' },
        userId: { type: 'string' },
        seasonId: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      if (p.seriesId) {
        return jf(`/Shows/${p.seriesId}/Episodes${qs({ userId, seasonId: p.seasonId, limit: p.limit })}`);
      }
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ userId: undefined, includeItemTypes: 'Episode', recursive: true, limit: p.limit })}`);
    },
  },
  {
    name: 'jellyfin.getMusicAlbums',
    description: 'Convenience: MusicAlbum items.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        artistIds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ ...p, userId: undefined, includeItemTypes: 'MusicAlbum', recursive: true })}`);
    },
  },
  {
    name: 'jellyfin.getBooks',
    description: 'Convenience: Book items.',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' }, limit: { type: 'integer' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ ...p, userId: undefined, includeItemTypes: 'Book', recursive: true })}`);
    },
  },

  // ── Metadata (3) ─────────────────────────────────────────────────
  {
    name: 'jellyfin.getGenres',
    description: 'All genres (with counts).',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        parentId: { type: 'string' },
        includeItemTypes: { type: 'array', items: { type: 'string' } },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Genres${qs({ ...p, userId })}`);
    },
  },
  {
    name: 'jellyfin.getStudios',
    description: 'All studios.',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Studios${qs({ userId })}`);
    },
  },
  {
    name: 'jellyfin.getArtists',
    description: 'All music artists.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        searchTerm: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      return jf(`/Artists${qs({ ...p, userId })}`);
    },
  },

  // ── Collections / Playlists (3) ──────────────────────────────────
  {
    name: 'jellyfin.getLibraries',
    description: 'Media library folders (top-level).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Library/MediaFolders'),
  },
  {
    name: 'jellyfin.getPlaylists',
    description: 'Convenience: Playlist items.',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ userId: undefined, includeItemTypes: 'Playlist', recursive: true })}`);
    },
  },
  {
    name: 'jellyfin.getCollections',
    description: 'Convenience: BoxSet (collection) items.',
    input_schema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const userId = p.userId || defaultUserId();
      const base = userId ? `/Users/${userId}/Items` : '/Items';
      return jf(`${base}${qs({ userId: undefined, includeItemTypes: 'BoxSet', recursive: true })}`);
    },
  },

  // ── System (4) ───────────────────────────────────────────────────
  {
    name: 'jellyfin.getSystemInfo',
    description: 'Server system info (version, OS, hardware acceleration, paths).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/System/Info'),
  },
  {
    name: 'jellyfin.getPublicSystemInfo',
    description: 'Public server info (unauthenticated-safe fields).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/System/Info/Public'),
  },
  {
    name: 'jellyfin.getActivityLog',
    description: 'Recent activity log entries.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        minDate: { type: 'string' },
        hasUserId: { type: 'boolean' },
      },
    },
    required_scope: 'read',
    handler: async (p) => jf(`/System/ActivityLog/Entries${qs(p)}`),
  },
  {
    name: 'jellyfin.getPlugins',
    description: 'Installed server plugins.',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Plugins'),
  },
];

function loadPro() {
  try {
    const Pro = require('jellyfin-ai-connect-pro');
    return typeof Pro === 'function' ? Pro({ jf, qs, defaultUserId }) : (Array.isArray(Pro) ? Pro : []);
  } catch (_e) { return []; }
}
function buildManifest(all) {
  return {
    protocol: 'servio/1.0',
    plugin: { slug: 'jellyfin-ai-connect', name: 'Jellyfin AI Connect', version: require('../package.json').version },
    tools: all.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, required_scope: t.required_scope })),
  };
}
function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const all = [...tools, ...loadPro()];
  const byName = Object.fromEntries(all.map(t => [t.name, t]));
  app.get('/api/aiconnect-manifest', (req, res) => res.json(buildManifest(all)));
  app.post('/api/aiconnect-tools/:name', async (req, res) => {
    const t = byName[req.params.name];
    if (!t) return res.status(404).json({ success: false, code: 'not_found', error: 'Tool not found' });
    try { res.json({ success: true, data: await t.handler(req.body || {}) }); }
    catch (err) { res.status(err.statusCode || 500).json({ success: false, code: err.code || 'error', error: err.message }); }
  });
  app.get('/health', (req, res) => res.json({ ok: true, tools: all.length }));
  return app;
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3093);
  createApp().listen(port, '0.0.0.0', () => console.log(`Jellyfin AI Connect on ${port}`));
}
module.exports = { createApp, jf, qs, defaultUserId, tools };
