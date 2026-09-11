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
  return { 'Authorization': `MediaBrowser Client="AI Connect", Device="Servio Sidecar", DeviceId="jellyfin-ai-connect", Version="1.0.0", Token="${t}"` };
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
  {
    name: 'jellyfin.listLibraries',
    description: 'List media library folders (top-level virtual folders).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Library/MediaFolders'),
  },
  {
    name: 'jellyfin.getLibraryDetails',
    description: 'Get details of a single library/collection by item id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items/${encodeURIComponent(p.id)}`),
  },
  {
    name: 'jellyfin.listLibraryItems',
    description: 'List items within a library (paged). Pass parentId to scope to a library.',
    input_schema: { type: 'object', properties: { parentId: { type: 'string' }, limit: { type: 'integer' }, startIndex: { type: 'integer' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items${qs({ Recursive: true, ...p })}`),
  },
  {
    name: 'jellyfin.searchLibraryItems',
    description: 'Search items across libraries by term.',
    input_schema: { type: 'object', required: ['searchTerm'], properties: { searchTerm: { type: 'string' }, limit: { type: 'integer' }, includeItemTypes: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items${qs({ Recursive: true, ...p })}`),
  },
  {
    name: 'jellyfin.getItemDetails',
    description: 'Full details of a single item by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items/${encodeURIComponent(p.id)}`),
  },
  {
    name: 'jellyfin.getItemMetadata',
    description: 'Metadata block of a single item (fields=Overview,Genres,Studios,People,Tags).',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items/${encodeURIComponent(p.id)}${qs({ fields: 'Overview,Genres,Studios,People,Tags,ProviderIds' })}`),
  },
  {
    name: 'jellyfin.getItemImages',
    description: 'List available images (Primary/Backdrop/Logo) for an item.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items/${encodeURIComponent(p.id)}/Images`),
  },
  {
    name: 'jellyfin.downloadItemImage',
    description: 'Get the URL for a specific item image type (Primary/Backdrop/Thumb/Logo).',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => ({ url: `${baseUrl()}/Items/${encodeURIComponent(p.id)}/Images/${encodeURIComponent(p.type || 'Primary')}` }),
  },
  {
    name: 'jellyfin.getRecentlyAdded',
    description: 'Recently added items for the current user.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' }, parentId: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Users/${defaultUserId()}/Items/Latest${qs(p)}`),
  },
  {
    name: 'jellyfin.listGenres',
    description: 'List all genres.',
    input_schema: { type: 'object', properties: { parentId: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Genres${qs(p)}`),
  },
  {
    name: 'jellyfin.listStudios',
    description: 'List all studios.',
    input_schema: { type: 'object', properties: { parentId: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Studios${qs(p)}`),
  },
  {
    name: 'jellyfin.listPeople',
    description: 'List people (actors, directors) known to the server.',
    input_schema: { type: 'object', properties: { searchTerm: { type: 'string' }, limit: { type: 'integer' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Persons${qs(p)}`),
  },
  {
    name: 'jellyfin.listTags',
    description: 'List available tag filters across the library.',
    input_schema: { type: 'object', properties: { parentId: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items/Filters2${qs(p)}`),
  },
  {
    name: 'jellyfin.getDuplicateItems',
    description: 'Find items sharing a provider id (potential duplicates).',
    input_schema: { type: 'object', properties: { includeItemTypes: { type: 'string' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items${qs({ Recursive: true, fields: 'ProviderIds', ...p })}`),
  },
  {
    name: 'jellyfin.getMissingMetadata',
    description: 'List items missing overview/images (metadata gaps).',
    input_schema: { type: 'object', properties: { parentId: { type: 'string' }, limit: { type: 'integer' } } },
    required_scope: 'read',
    handler: async (p) => jf(`/Items${qs({ Recursive: true, fields: 'Overview', ...p })}`),
  },
];

function uid(p) {
  const u = (p && p.userId) || defaultUserId();
  if (!u) { const e = new Error('userId required (pass userId or set JELLYFIN_USER_ID)'); e.statusCode = 400; e.code = 'invalid_argument'; throw e; }
  return u;
}
function need(p, k) {
  const v = p && p[k];
  if (v === undefined || v === null || v === '') { const e = new Error(`Missing required argument: ${k}`); e.statusCode = 400; e.code = 'invalid_argument'; throw e; }
  return v;
}

const proTools = [
  {
    name: 'jellyfin.markPlayed',
    description: 'Mark an item as played for the user.',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string', description: 'Item id (32-hex)' }, userId: { type: 'string' }, datePlayed: { type: 'string', description: 'ISO 8601' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserPlayedItems/${encodeURIComponent(need(p, 'itemId'))}${qs({ userId: uid(p), datePlayed: p.datePlayed })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.markUnplayed',
    description: 'Mark an item as unplayed for the user.',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserPlayedItems/${encodeURIComponent(need(p, 'itemId'))}${qs({ userId: uid(p) })}`, { method: 'DELETE' }),
  },
  {
    name: 'jellyfin.setFavorite',
    description: 'Add an item to the user\u2019s favorites.',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserFavoriteItems/${encodeURIComponent(need(p, 'itemId'))}${qs({ userId: uid(p) })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.unsetFavorite',
    description: 'Remove an item from the user\u2019s favorites.',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserFavoriteItems/${encodeURIComponent(need(p, 'itemId'))}${qs({ userId: uid(p) })}`, { method: 'DELETE' }),
  },
  {
    name: 'jellyfin.setRating',
    description: 'Set like/dislike on an item. likes=true is a like, false is a dislike.',
    input_schema: { type: 'object', required: ['itemId', 'likes'], properties: { itemId: { type: 'string' }, likes: { type: 'boolean' }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserItems/${encodeURIComponent(need(p, 'itemId'))}/Rating${qs({ userId: uid(p), likes: need(p, 'likes') })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.clearRating',
    description: 'Clear the like/dislike rating on an item.',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserItems/${encodeURIComponent(need(p, 'itemId'))}/Rating${qs({ userId: uid(p) })}`, { method: 'DELETE' }),
  },
  {
    name: 'jellyfin.updateUserData',
    description: 'Bulk-update user data on an item (IsFavorite, Played, PlaybackPositionTicks, Rating, PlayCount).',
    input_schema: { type: 'object', required: ['itemId', 'data'], properties: { itemId: { type: 'string' }, userId: { type: 'string' }, data: { type: 'object', description: '{IsFavorite, Played, PlaybackPositionTicks, Rating, PlayCount}' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/UserItems/${encodeURIComponent(need(p, 'itemId'))}/UserData${qs({ userId: uid(p) })}`, { method: 'POST', body: need(p, 'data') }),
  },
  {
    name: 'jellyfin.createPlaylist',
    description: 'Create a playlist. name required; ids are initial item ids.',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, userId: { type: 'string' }, mediaType: { type: 'string' }, isPublic: { type: 'boolean' } } },
    required_scope: 'write',
    handler: async (p) => jf('/Playlists', { method: 'POST', body: { Name: need(p, 'name'), Ids: p.ids || [], UserId: uid(p), MediaType: p.mediaType, IsPublic: p.isPublic } }),
  },
  {
    name: 'jellyfin.addToPlaylist',
    description: 'Add items to a playlist. playlistId and ids (item ids) required.',
    input_schema: { type: 'object', required: ['playlistId', 'ids'], properties: { playlistId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, userId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Playlists/${encodeURIComponent(need(p, 'playlistId'))}/Items${qs({ ids: need(p, 'ids'), userId: uid(p) })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.removeFromPlaylist',
    description: 'Remove items from a playlist. entryIds are PlaylistItemId values from getPlaylistItems (NOT item ids).',
    input_schema: { type: 'object', required: ['playlistId', 'entryIds'], properties: { playlistId: { type: 'string' }, entryIds: { type: 'array', items: { type: 'string' }, description: 'PlaylistItemId values, not item ids' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Playlists/${encodeURIComponent(need(p, 'playlistId'))}/Items${qs({ entryIds: need(p, 'entryIds') })}`, { method: 'DELETE' }),
  },
  {
    name: 'jellyfin.movePlaylistItem',
    description: 'Move a playlist entry to a new index. entryId is a PlaylistItemId.',
    input_schema: { type: 'object', required: ['playlistId', 'entryId', 'newIndex'], properties: { playlistId: { type: 'string' }, entryId: { type: 'string' }, newIndex: { type: 'integer' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Playlists/${encodeURIComponent(need(p, 'playlistId'))}/Items/${encodeURIComponent(need(p, 'entryId'))}/Move/${encodeURIComponent(need(p, 'newIndex'))}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.createCollection',
    description: 'Create a collection (box set). name required; ids are initial item ids.',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Collections${qs({ name: need(p, 'name'), ids: p.ids, parentId: p.parentId })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.addToCollection',
    description: 'Add items to a collection. collectionId and ids required.',
    input_schema: { type: 'object', required: ['collectionId', 'ids'], properties: { collectionId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Collections/${encodeURIComponent(need(p, 'collectionId'))}/Items${qs({ ids: need(p, 'ids') })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.removeFromCollection',
    description: 'Remove items from a collection. collectionId and ids required.',
    input_schema: { type: 'object', required: ['collectionId', 'ids'], properties: { collectionId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Collections/${encodeURIComponent(need(p, 'collectionId'))}/Items${qs({ ids: need(p, 'ids') })}`, { method: 'DELETE' }),
  },
  {
    name: 'jellyfin.playOnSession',
    description: 'Start playback on a remote session. sessionId, playCommand (PlayNow/PlayNext/PlayLast) and itemIds required.',
    input_schema: { type: 'object', required: ['sessionId', 'playCommand', 'itemIds'], properties: { sessionId: { type: 'string' }, playCommand: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' } }, startPositionTicks: { type: 'integer' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Sessions/${encodeURIComponent(need(p, 'sessionId'))}/Playing${qs({ playCommand: need(p, 'playCommand'), itemIds: need(p, 'itemIds'), startPositionTicks: p.startPositionTicks })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.sessionPlaystate',
    description: 'Send a playstate command to a session (Stop/Pause/Unpause/NextTrack/PreviousTrack/Seek/PlayPause).',
    input_schema: { type: 'object', required: ['sessionId', 'command'], properties: { sessionId: { type: 'string' }, command: { type: 'string' }, seekPositionTicks: { type: 'integer' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Sessions/${encodeURIComponent(need(p, 'sessionId'))}/Playing/${encodeURIComponent(need(p, 'command'))}${qs({ seekPositionTicks: p.seekPositionTicks })}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.sessionCommand',
    description: 'Send a general command to a session (VolumeUp/VolumeDown/Mute/SetVolume/GoHome/SetSubtitleStreamIndex/...).',
    input_schema: { type: 'object', required: ['sessionId', 'command'], properties: { sessionId: { type: 'string' }, command: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Sessions/${encodeURIComponent(need(p, 'sessionId'))}/Command/${encodeURIComponent(need(p, 'command'))}`, { method: 'POST' }),
  },
  {
    name: 'jellyfin.sessionMessage',
    description: 'Display a message on a session. sessionId and text required.',
    input_schema: { type: 'object', required: ['sessionId', 'text'], properties: { sessionId: { type: 'string' }, text: { type: 'string' }, header: { type: 'string' }, timeoutMs: { type: 'integer' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Sessions/${encodeURIComponent(need(p, 'sessionId'))}/Message`, { method: 'POST', body: { Text: need(p, 'text'), Header: p.header, TimeoutMs: p.timeoutMs } }),
  },
  {
    name: 'jellyfin.refreshLibrary',
    description: 'Trigger a scan of all libraries (empty body).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'admin',
    handler: async () => jf('/Library/Refresh', { method: 'POST' }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.refreshItem',
    description: 'Refresh metadata for an item. itemId required; metadataRefreshMode (None/ValidationOnly/Default/FullRefresh).',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, metadataRefreshMode: { type: 'string' }, imageRefreshMode: { type: 'string' }, replaceAllMetadata: { type: 'boolean' }, replaceAllImages: { type: 'boolean' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/Items/${encodeURIComponent(need(p, 'itemId'))}/Refresh${qs({ metadataRefreshMode: p.metadataRefreshMode || 'Default', imageRefreshMode: p.imageRefreshMode, replaceAllMetadata: p.replaceAllMetadata, replaceAllImages: p.replaceAllImages })}`, { method: 'POST' }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.updateItem',
    description: 'Update item metadata. itemId and data (BaseItemDto: Name/Overview/Genres/Tags/...) required.',
    input_schema: { type: 'object', required: ['itemId', 'data'], properties: { itemId: { type: 'string' }, data: { type: 'object' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/Items/${encodeURIComponent(need(p, 'itemId'))}`, { method: 'POST', body: need(p, 'data') }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.deleteItem',
    description: 'Delete an item from the library. itemId required (needs EnableContentDeletion).',
    input_schema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' } } },
    required_scope: 'write',
    handler: async (p) => jf(`/Items/${encodeURIComponent(need(p, 'itemId'))}`, { method: 'DELETE' }).then((r) => r || { success: true, deleted: p.itemId }),
  },
  {
    name: 'jellyfin.createUser',
    description: 'Create a user. name required; password optional.',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, password: { type: 'string' } } },
    required_scope: 'admin',
    handler: async (p) => jf('/Users/New', { method: 'POST', body: { Name: need(p, 'name'), Password: p.password } }),
  },
  {
    name: 'jellyfin.deleteUser',
    description: 'Delete a user by id.',
    input_schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/Users/${encodeURIComponent(need(p, 'userId'))}`, { method: 'DELETE' }).then((r) => r || { success: true, deleted: p.userId }),
  },
  {
    name: 'jellyfin.setUserPolicy',
    description: 'Update a user policy. userId and policy object (IsAdministrator/IsDisabled/EnableAllFolders/...) required.',
    input_schema: { type: 'object', required: ['userId', 'policy'], properties: { userId: { type: 'string' }, policy: { type: 'object' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/Users/${encodeURIComponent(need(p, 'userId'))}/Policy`, { method: 'POST', body: need(p, 'policy') }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.restartServer',
    description: 'Restart the Jellyfin server (empty body).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'admin',
    handler: async () => jf('/System/Restart', { method: 'POST' }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.shutdownServer',
    description: 'Shut down the Jellyfin server (empty body).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'admin',
    handler: async () => jf('/System/Shutdown', { method: 'POST' }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.runScheduledTask',
    description: 'Start a scheduled task by id.',
    input_schema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/ScheduledTasks/Running/${encodeURIComponent(need(p, 'taskId'))}`, { method: 'POST' }).then((r) => r || { success: true }),
  },
  {
    name: 'jellyfin.stopScheduledTask',
    description: 'Stop a running scheduled task by id.',
    input_schema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    required_scope: 'admin',
    handler: async (p) => jf(`/ScheduledTasks/Running/${encodeURIComponent(need(p, 'taskId'))}`, { method: 'DELETE' }).then((r) => r || { success: true }),
  },
];

function loadPro() {
  if ((process.env.AICONNECT_EDITION || 'free').toLowerCase() !== 'pro') return [];
  return proTools;
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
