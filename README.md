# Steam Family Sharing Source

A Millennium plugin that groups shared Steam games by lender (owner) and keeps owner collections in sync automatically.

## Features

- Detects family-shared game owners and groups games per owner.
- Creates/updates one collection per owner and syncs app membership automatically.
- Owner names are fetched from Steam Community profile XML:
  - `https://steamcommunity.com/profiles/{steam_id}/?xml=1`
- Owner name cache is persisted to avoid repeated network lookups.
- Settings page supports:
  - `Reload Owner Names` (force refresh from Steam web)
  - Per-owner `Username` override
  - Collection name template with `{name}` placeholder

## Name Resolution

Owner display name priority:

1. Manual `Username` override from settings
2. Steam web name from profile XML (`steamID`)
3. Last 6 digits of `steam_id` (fallback)

## Collection Naming

Collection names are always auto-generated from a template.

- Template key: `sfs.collectionNameTemplate.v1`
- Placeholder: `{name}`
- Example templates:
  - `{name} Library`
  - `[Family] {name}`

If `{name}` is missing, it will be appended automatically.

## Requirements

- [Millennium](https://github.com/SteamClientHomebrew/Millennium)

## Development

```powershell
pnpm install
pnpm run dev
```

## Production Build

```powershell
pnpm run build
```

Put this plugin folder under your Millennium plugins directory and enable it from Steam -> Plugins.

Common `MILLENNIUM_PATH` locations:

- Windows: Steam install directory (for example `C:\Program Files (x86)\Steam`)
- Linux: `~/.local/share/millennium`

## Settings Page

- `Collection Name Template`
  - Controls generated collection names.
  - Must contain `{name}` placeholder (auto-fixed if missing).
- `Reload Owner Names`
  - Forces owner-name refresh from Steam web.
  - Then re-syncs and renames collections using current template.
- Per owner:
  - `Steam ID` (read-only, copyable)
  - `Username` (editable)
  - `Apply` to save and re-sync

## Stored Data

Runtime data file:

- `backend/sfs-data.json`

Main keys (values are JSON strings):

- `sfs.collectionNameBackup.v1`: `steam_id -> current collection name`
- `sfs.ownerNames.v1`: `steam_id -> cached web owner name`
- `sfs.ownerNameOverrides.v1`: `steam_id -> manual username`
- `sfs.collectionNameTemplate.v1`: collection naming template

## Notes

- Sync is triggered while browsing Steam library routes.
- If backend storage fails, frontend falls back to `localStorage`.
