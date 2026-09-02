const express = require('express');
const fetch = require('node-fetch');

/**
 * Jellyfin sidecar. Auth: API key from Dashboard → API Keys, sent as
 * `X-Emby-Token` header. Jellyfin scopes almost every call by `userId` because
 * the same library is presented differently per user (watch state, parental
 * filters); we default to `JELLYFIN_USER_ID` when the caller doesn't pass one.
 */
function baseUrl() {
  const u = process.env.JELLYFIN_BASE_URL;
  if (!u) throw new Error('JELLYFIN_BASE_URL not set');
  return u.replace(/\/$/, '');
}
function authHeader() {
  const t = process.env.JELLYFIN_API_KEY;
  if (!t) throw new Error('JELLYFIN_API_KEY not set');
  return t;
}
function defaultUserId() {
  return process.env.JELLYFIN_USER_ID || '';
}
async function jf(path, opts = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'X-Emby-Token': authHeader(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) {}
  if (!res.ok) {
    const err = new Error(json?.Message || text || `Jellyfin API ${res.status}`);
    err.statusCode = res.status;
    err.code = 'jellyfin_error';
    throw err;
  }
  return json;
}

const tools = [
  {
    name: 'jellyfin.getSystemInfo',
    description: 'Fetch server info (version, id, name).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/System/Info/Public'),
  },
  {
    name: 'jellyfin.getUsers',
    description: 'List all Jellyfin users (id, name, policy).',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Users'),
  },
  {
    name: 'jellyfin.getLibraries',
    description: "List a user's media libraries (top-level virtual folders).",
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'string', description: 'defaults to JELLYFIN_USER_ID' } },
    },
    required_scope: 'read',
    handler: async (p) => {
      const uid = p.user_id || defaultUserId();
      if (!uid) throw new Error('user_id required (set JELLYFIN_USER_ID or pass user_id)');
      return jf(`/Users/${uid}/Views`);
    },
  },
  {
    name: 'jellyfin.getItems',
    description: 'List items with rich filters (types, sort, parent library, search, paging).',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        parent_id: { type: 'string', description: 'Library / folder id' },
        include_item_types: { type: 'string', description: 'Comma-separated: Movie,Series,Audio,Book,...' },
        search_term: { type: 'string' },
        recursive: { type: 'boolean' },
        sort_by: { type: 'string', description: 'e.g. "DateCreated,SortName"' },
        sort_order: { type: 'string', description: 'Ascending | Descending' },
        limit: { type: 'integer' },
        start_index: { type: 'integer' },
        fields: { type: 'string', description: 'Comma-separated extra fields (Overview,Genres,...)' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const uid = p.user_id || defaultUserId();
      const qs = new URLSearchParams();
      if (p.parent_id) qs.set('ParentId', p.parent_id);
      if (p.include_item_types) qs.set('IncludeItemTypes', p.include_item_types);
      if (p.search_term) qs.set('SearchTerm', p.search_term);
      if (p.recursive !== undefined) qs.set('Recursive', String(!!p.recursive));
      if (p.sort_by) qs.set('SortBy', p.sort_by);
      if (p.sort_order) qs.set('SortOrder', p.sort_order);
      if (p.limit) qs.set('Limit', String(p.limit));
      if (p.start_index) qs.set('StartIndex', String(p.start_index));
      if (p.fields) qs.set('Fields', p.fields);
      const q = qs.toString();
      const path = uid ? `/Users/${uid}/Items` : '/Items';
      return jf(`${path}${q ? '?' + q : ''}`);
    },
  },
  {
    name: 'jellyfin.getItem',
    description: "Fetch a single item's full metadata.",
    input_schema: {
      type: 'object', required: ['item_id'],
      properties: {
        item_id: { type: 'string' },
        user_id: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const uid = p.user_id || defaultUserId();
      return jf(uid ? `/Users/${uid}/Items/${p.item_id}` : `/Items/${p.item_id}`);
    },
  },
  {
    name: 'jellyfin.getLatestMedia',
    description: 'Newly added items for a user (paged).',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        parent_id: { type: 'string' },
        limit: { type: 'integer', description: 'default 20' },
        include_item_types: { type: 'string' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const uid = p.user_id || defaultUserId();
      if (!uid) throw new Error('user_id required');
      const qs = new URLSearchParams();
      qs.set('Limit', String(p.limit || 20));
      if (p.parent_id) qs.set('ParentId', p.parent_id);
      if (p.include_item_types) qs.set('IncludeItemTypes', p.include_item_types);
      return jf(`/Users/${uid}/Items/Latest?${qs.toString()}`);
    },
  },
  {
    name: 'jellyfin.getResumeItems',
    description: 'Items the user has partially watched (Continue Watching).',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    required_scope: 'read',
    handler: async (p) => {
      const uid = p.user_id || defaultUserId();
      if (!uid) throw new Error('user_id required');
      const qs = p.limit ? `?Limit=${p.limit}` : '';
      return jf(`/Users/${uid}/Items/Resume${qs}`);
    },
  },
  {
    name: 'jellyfin.getSessions',
    description: 'Live playback sessions across all clients.',
    input_schema: { type: 'object', properties: {} },
    required_scope: 'read',
    handler: async () => jf('/Sessions'),
  },
];

function loadPro() {
  try {
    const Pro = require('jellyfin-ai-connect-pro');
    return typeof Pro === 'function' ? Pro({ jf, defaultUserId }) : (Array.isArray(Pro) ? Pro : []);
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
module.exports = { createApp, jf, tools };
