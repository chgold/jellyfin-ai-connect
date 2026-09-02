# Jellyfin AI Connect

Sidecar exposing Jellyfin REST API as Servio-Protocol tools.

## Free
- `jellyfin.getSystemInfo`, `getUsers`, `getSessions`
- `jellyfin.getLibraries`, `getItems`, `getItem`
- `jellyfin.getLatestMedia`, `getResumeItems`

## Pro (`jellyfin-ai-connect-pro`)
- `jellyfin_pro.markPlayed`, `markUnplayed`, `toggleFavorite`
- `jellyfin_pro.remotePlay`, `remoteCommand`
- `jellyfin_pro.createPlaylist`
- `jellyfin_pro.refreshLibrary`, `createUser`, `deleteUser` (admin)

## Config
```
JELLYFIN_BASE_URL=http://jellyfin.local:8096
JELLYFIN_API_KEY=<from Dashboard → API Keys>
JELLYFIN_USER_ID=<default user id for scoped calls>
PORT=3093
```

## Run
```
npm install && npm start
```
