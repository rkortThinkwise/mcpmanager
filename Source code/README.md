# MCP Manager

A cross-platform desktop app that manages every MCP server connection Claude
Code has, replacing a manual process that otherwise requires editing
`~/.claude.json` by hand and running CLI commands in the right order.

The connections list is the home screen. From there you can add a connection
through a full-screen wizard, view a connection's details and scopes, refresh
its scopes against what the server now advertises, reauthorize it, or delete it.

Built with **Electron + React + MUI**. The renderer never touches the
filesystem, the network, or secrets; the main process owns all of it.

## Architecture

```text
src/
  shared/
    mcp.js               scope filter / URL derivation / scope diff — imported
                         by BOTH main and renderer so the two can't drift
  main/                  Node.js main process
    index.js             app lifecycle + BrowserWindow
    ipc.js               IPC handlers (invoke/handle) with error envelopes
    validate.js          shape checks for every payload crossing the IPC boundary
    services/
      connections.js     the manager's view of the config: list, details,
                         scope refresh, reauthorize, add, delete
      scopeWatcher.js    periodic scope-drift check, pushes results to renderer
      settings.js        check interval + other preferences
      configFile.js      locate/validate/read ~/.claude.json and .mcp.json,
                         entry shape, casing check
      connectivity.js    reachability + OAuth metadata/scope discovery
      claudeCli.js       Claude Code CLI detection, registration, login, removal
      secrets.js         safeStorage-backed client-secret store
  preload/
    index.js             contextBridge — exposes window.api, no raw Node
  renderer/              React + MUI
    src/
      App.jsx, theme.js, format.js
      state/             ConnectionsContext (list), WizardContext (add flow)
      components/        TopBar, ConnectionCard, StatusBadge, ScopeChip, StatusRow
      screens/           ConnectionsList, EmptyState, the four modals,
                         AddConnectionWizard/ (6 steps)
```

The renderer never touches Node APIs directly. Everything crosses the
`contextBridge` in `src/preload/index.js`, which matters because the app handles
an OAuth client secret.

### Why writes go through the CLI, not a JSON write

Reads come straight from `~/.claude.json`. Writes deliberately do not.

Claude Code keeps the OAuth **client secret** in the OS keychain (or its own
credentials file), never in the config. An entry written by hand therefore has
no secret: the browser login succeeds, the token exchange then fails with
`invalid_client`, and `/mcp` hangs forever on "Completing authentication in
browser...". The only supported way to store the secret is
`claude mcp add-json <name> <json> --client-secret`, so every write — adding a
connection, applying a scope refresh, deleting — goes through
`services/claudeCli.js`.

The same constraint shapes authorization: `claude mcp login` requires a real
TTY, which an Electron app doesn't have, so it's launched in a terminal window
and the app polls for completion. See the comment blocks in
`services/claudeCli.js` for the full reasoning.

One consequence worth knowing: applying a scope refresh re-registers the
connection, which needs the client secret again. If the connection wasn't added
through this app, the refresh flow asks for the secret rather than silently
registering a secret-less entry that would fail later.

### Scopes: `user`, `local`, `project`

The app uses Claude Code's own scope names verbatim, so nothing is translated at
the CLI boundary:

| scope | who gets it | stored in |
| --- | --- | --- |
| `user` | you, in every project | top-level `mcpServers` in `~/.claude.json` |
| `local` | only you, in one project | `projects[<path>].mcpServers` in `~/.claude.json` |
| `project` | everyone on the project | `<path>/.mcp.json`, committed to the repo |

**Don't reintroduce the old names.** Claude Code's earlier releases called
`local` "project" and called `user` "global". This app used those retired names
until they became actively misleading: its "project" meant Claude Code's
`local`, while Claude Code's real `project` scope means a shared `.mcp.json`.

This app never *creates* an entry in `project` scope. The wizard writes `user` or
`local` only, because `.mcp.json` is committed to source control and this flow
handles a client secret; `duplicateConnection` refuses project scope for the same
reason (it used to default to the source's scope, so duplicating a project
connection would have added a new one to the shared file).

Project-scoped servers are otherwise fully manageable — listed, refreshed,
renamed, reauthorized, enabled/disabled, deleted. Three of those rewrite the
shared file, because re-registering through the CLI is how they're carried out:
delete, rename, and applying a scope change. Each says so before it acts
(`DeleteConfirmModal`, and `ProjectScopeWarning` in the rename and scope-change
dialogs). Enable/disable is the exception and deliberately doesn't touch the
file — it goes through `disabledMcpjsonServers` in a local, gitignored settings
file instead. See `services/claudeSettings.js`.

### Connection status

`status` is derived on every read, never stored:

| status | meaning |
| --- | --- |
| `connected` | authenticated, and scopes match what the server advertises |
| `scope_drift` | authenticated, but the last check found the server's scopes changed |
| `warn` | registered but not authorized yet — reauthorizing fixes it |
| `error` | the CLI can't see it, or couldn't be run |

Precedence is error → warn → scope_drift → connected: a connection that isn't
authorized has a more urgent problem than one whose scopes drifted.

Deriving one status spawns `claude mcp get`, so the list would otherwise be one
process per connection, repeated on every `connections:changed` event. What the
CLI reported is cached for ten seconds and invalidated explicitly by everything
in `connections.js` that writes, and the list derives at most four at a time.
`getConnectionDetails` always bypasses the cache: it's what the authorization
poller calls, and it's watching for exactly the transition a cached answer would
hide.

### The periodic scope check

`services/scopeWatcher.js` re-reads each server's `.well-known` OAuth metadata
on an interval (default 6 hours, configurable in Settings, `0` = manual only)
and records any difference against the configured scopes. It's read-only:
nothing is written to the Claude config and no authorization is triggered — it
only decides whether a connection shows `scope_refresh needed`.

It lives in the main process because that's what owns the network and the
config, and because a renderer-side interval would be subject to Chromium's
background timer throttling. It schedules with a fresh `setTimeout` per run
rather than `setInterval`, so a slow server can't cause runs to pile up.

### Our own per-connection record

`connections-meta.json` in the app's userData directory holds what Claude Code
doesn't track: `lastVerified` (when this app last saw the CLI report a
connection authenticated) and the last scope-drift result. Never written into
the Claude config. Records are keyed by an id encoding name + scope + project
path, so changing any of those strands the old record — `listConnections()`
prunes anything that no longer matches a live connection. Everything in the file
is re-derivable, so losing it costs nothing.

### Client secrets

Claude Code will not hand back a stored client secret — `--client-secret` writes
it, and `claude mcp get` only reports *that* it's configured. Since applying a
scope refresh has to re-register the connection (which needs the secret again),
this app keeps its own copy via `safeStorage` and reuses it. The wizard stores it
at add time, so connections added here never prompt; a connection added outside
this app is asked once on its first scope refresh, then remembered.

Records in `secrets.json` are keyed by **connection id**, not by server name. A
name is only unique within one scope and project — the list groups same-named
servers across projects — so the original name-keyed store made two unrelated
connections share one record: deleting or renaming either wiped the other's
secret, and `hasStoredSecret` reported the wrong thing for both. A version-1
(name-keyed) store is still read, and `listConnections()` migrates it: that's
the only place with the full list, which is what's needed to say which
connections a shared record was answering for. A legacy record matching no
connection is left alone rather than deleted — a client secret can't be
re-derived, and a connection can be temporarily invisible.

## Prerequisites

- Node.js 18+ (this repo was built and verified against Node 24).
- On this machine Node is provisioned through pnpm: `pnpm env use --global lts`.

## Develop

```bash
npm install          # or: pnpm install
npm run dev          # launches Electron with the Vite dev server + HMR
```

## Build

```bash
npm run build        # compiles main/preload/renderer to ./out
npm run start        # preview the production build in Electron
```

## Package for distribution

```bash
npm run dist:win     # NSIS (x64/arm64) + portable exe  -> ./dist
npm run dist:mac     # universal .dmg
npm run dist:linux   # AppImage + deb + rpm
```

Targets are configured in [`electron-builder.yml`](electron-builder.yml).

### Code signing (Windows, internal distribution)

`npm run dist:win` produces an **unsigned** installer, which triggers
SmartScreen. There's no publicly-trusted CA certificate for this app — those
now require the private key to live on a hardware token or cloud HSM, and
cost money either way. For distributing to Thinkwise-managed machines, a free
self-signed certificate works instead, as long as the machines are told to
trust it.

**1. Generate the certificate once** (per signer, or share the `.pfx` securely
within the team):

```powershell
npm run cert:create
```

Prompts for a `.pfx` password and writes to `certs/` (gitignored — never
commit the `.pfx`, it's the private key):

- `certs/mcp-manager-codesign.pfx` — private key + cert, keep secret
- `certs/mcp-manager-codesign.cer` — public cert only, safe to distribute

**2. Build a signed installer:**

```powershell
npm run dist:win:signed
```

Prompts for the `.pfx` password, sets `CSC_LINK`/`CSC_KEY_PASSWORD` for that
process only, and calls `dist:win` — electron-builder picks those env vars up
automatically and signs the NSIS installer and portable exe.

**3. Trust the certificate on machines that will run the installer.** A
self-signed cert isn't in Windows' trusted root store by default, so without
this step SmartScreen still warns (with a slightly less scary "unknown
publisher" message replaced by the real one, but still unverified). Distribute
`certs/mcp-manager-codesign.cer` (not the `.pfx`) and import it into **both**
`Trusted Root Certification Authorities` and `Trusted Publishers`:

- **Manually**: double-click the `.cer` → *Install Certificate* → *Local
  Machine* → place in both stores above.
- **Domain-joined machines**: Group Policy → Computer Configuration → Windows
  Settings → Security Settings → Public Key Policies → import the `.cer` into
  both *Trusted Root Certification Authorities* and *Trusted Publishers*.
- **Intune**: a Trusted Certificate configuration profile targeting both
  stores.

This only works for machines you (or Thinkwise IT) control. Anyone else who
downloads the installer will still see a SmartScreen warning — that requires
a real CA-issued certificate (see "Known open items" below).

### Known open items (from the plan)

- **Code signing**: the self-signed route above covers internal distribution.
  Public distribution still needs a CA-issued certificate (or Apple Developer
  ID + notarization for macOS) — not sourced yet, since both now require the
  private key on a hardware token or cloud HSM (e.g. Azure Trusted Signing).
- **App icons**: `build/` currently ships the brand SVG only. electron-builder
  wants platform icons (`.ico`/`.icns`/`png`) for a fully branded installer;
  add them under `build/` before shipping.
- **Auto-update**: deferred. Linux (AppImage/deb/rpm) has no built-in Squirrel
  equivalent; a manual "check for updates" flow would be needed.
- **Linux secret storage**: `safeStorage` needs a running secret-service
  provider (GNOME Keyring / KWallet). The app checks
  `isEncryptionAvailable()` at startup and warns if the secret can't be
  OS-encrypted rather than silently storing plaintext.
