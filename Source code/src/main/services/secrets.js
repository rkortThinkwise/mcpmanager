import path from 'path'
import { app, safeStorage } from 'electron'
import { atomicWriteJson, readJsonSafe } from './fileStore'

// We use Electron's built-in safeStorage (Keychain on macOS, DPAPI on Windows,
// libsecret/kwallet on Linux) rather than the archived keytar. The one edge
// case: on minimal/headless Linux without a running secret-service provider,
// isEncryptionAvailable() returns false — the renderer surfaces a warning and
// we fall back to a clearly-marked plaintext store instead of failing.
//
// Records are keyed by *connection id* (scope + project path + name), not by
// server name. A name is only unique within one scope and project — the list
// itself groups same-named servers across projects — so a name-keyed store made
// two unrelated connections share one record: deleting or renaming either wiped
// the other's secret, and hasSecret() reported the wrong thing for both.
//
// Store shape (version 2):
//   { version: 2, byConnection: { <id>: record }, legacyByName: { <name>: record } }
// A file without `version` is a version-1 store, which was a bare
// name -> record map; it is read as `legacyByName` and migrated on first list.

const STORE_VERSION = 2

function storePath() {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function emptyStore() {
  return { version: STORE_VERSION, byConnection: {}, legacyByName: {} }
}

// Tracks the outcome of the most recent readStore() call, so a caller that
// isn't in the hot path (system:info) can report "is the secrets store
// currently readable?" without forcing every getSecret/hasSecret call to
// thread an extra return value through. Reset on every read, so a since-fixed
// or restored file is reflected immediately.
let lastReadCorrupted = false
let lastReadError = null

function readStore() {
  const { data: raw, corrupted, error } = readJsonSafe(storePath(), null)
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    lastReadCorrupted = true
    lastReadError = 'secrets.json does not contain a JSON object.'
    return emptyStore()
  }
  lastReadCorrupted = corrupted
  lastReadError = error
  if (raw === null) return emptyStore()
  // No version marker: the whole document is the old name -> record map.
  if (raw.version !== STORE_VERSION) {
    return { version: STORE_VERSION, byConnection: {}, legacyByName: raw }
  }
  return {
    version: STORE_VERSION,
    byConnection: raw.byConnection && typeof raw.byConnection === 'object' ? raw.byConnection : {},
    legacyByName: raw.legacyByName && typeof raw.legacyByName === 'object' ? raw.legacyByName : {}
  }
}

/**
 * Whether the secrets store could be read cleanly the last time anything
 * touched it. Used by `system:info` to warn when it couldn't — a corrupted
 * secrets.json silently drops every stored OAuth client secret otherwise,
 * with nothing telling the user why connections started asking for them
 * again. Forces a fresh read first so a since-restored file is picked up.
 */
export function getStoreHealth() {
  readStore()
  return { corrupted: lastReadCorrupted, error: lastReadError }
}

// 0600 unconditionally: this file holds the OAuth client secret in cleartext
// on the fallback (no-OS-encryption) path, so it must never be group- or
// world-readable regardless of what wrote it before.
//
// Deliberately no try/catch: a failed write here means the secret this call
// was asked to store is NOT actually stored, and every caller (storeSecret,
// deleteSecret) needs that failure to propagate rather than report success —
// see connections.js's addConnection/duplicateConnection/renameConnection,
// which only proceed past registration once the secret is confirmed stored.
function writeStore(store) {
  atomicWriteJson(storePath(), store, { mode: 0o600 })
}

export function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encode(secret) {
  if (isEncryptionAvailable()) {
    return { encrypted: true, value: safeStorage.encryptString(secret).toString('base64') }
  }
  return { encrypted: false, value: secret }
}

function decode(record) {
  if (!record) return null
  if (record.encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(record.value, 'base64'))
    } catch {
      return null
    }
  }
  return record.value
}

/**
 * The record for a connection: its own, or the version-1 record still filed
 * under its bare name if this connection hasn't been migrated yet.
 */
function recordFor(store, { id, name }) {
  return store.byConnection[id] || (name ? store.legacyByName[name] : null) || null
}

/**
 * Persist the client secret for a connection. `target` is anything carrying the
 * connection's `id` and `name`. Returns whether it was stored with OS-level
 * encryption so the caller can warn when it wasn't.
 */
export function storeSecret(target, secret) {
  const store = readStore()
  const record = encode(secret)
  store.byConnection[target.id] = record
  // This connection now has its own record, so the shared name-keyed one is no
  // longer what answers for it.
  if (target.name && store.legacyByName[target.name]) delete store.legacyByName[target.name]
  writeStore(store)
  return { encrypted: record.encrypted }
}

export function getSecret(target) {
  return decode(recordFor(readStore(), target))
}

/**
 * Whether a secret is held for this connection, without decrypting it.
 *
 * Kept separate from usableSecret() because the two answer different questions
 * and only one of them is safe to ask on a hot path.
 */
export function hasSecret(target) {
  return Boolean(recordFor(readStore(), target))
}

/**
 * Whether a stored secret can actually be READ BACK.
 *
 * Presence alone was the wrong question for the UI. safeStorage is bound to the
 * OS user — DPAPI on Windows — so a profile migration or an administrative
 * password reset leaves the record in place but permanently undecryptable.
 * Reporting "stored" for that hid the secret field while the refresh then failed
 * with "enter the client secret to continue", leaving nowhere to enter it.
 *
 * Decrypting to answer is the point, so this is deliberately not called per
 * connection on a list refresh unless a record exists at all.
 */
export function usableSecret(target) {
  const record = recordFor(readStore(), target)
  if (!record) return false
  return decode(record) !== null
}

/** Drop the stored secret, so deleting a connection leaves nothing behind. */
export function deleteSecret(target) {
  const store = readStore()
  let removed = false
  if (store.byConnection[target.id]) {
    delete store.byConnection[target.id]
    removed = true
  }
  // A name-keyed record still present after migration belongs to no live
  // connection, so it can't be another connection's secret.
  if (target.name && store.legacyByName[target.name]) {
    delete store.legacyByName[target.name]
    removed = true
  }
  if (removed) writeStore(store)
  return removed
}

/**
 * Move version-1 name-keyed records onto the connections they belong to.
 *
 * Called with the full connection list, which is the only place we can tell
 * which connections a shared name-keyed record was answering for. A name that
 * matches several connections gets the record copied to each: that is exactly
 * what the old store did implicitly, so this preserves behaviour rather than
 * picking a winner.
 *
 * A legacy record matching no connection is deliberately left alone — we can't
 * re-derive a client secret, and a connection could be temporarily invisible
 * (an unreadable config, a project on a disconnected drive).
 */
export function migrateLegacyKeys(connections) {
  const store = readStore()
  const names = Object.keys(store.legacyByName)
  if (names.length === 0) return { migrated: 0 }

  let migrated = 0
  for (const name of names) {
    const matches = connections.filter((c) => c.name === name)
    if (matches.length === 0) continue
    for (const conn of matches) {
      // Never overwrite a record the connection already has of its own.
      if (!store.byConnection[conn.id]) store.byConnection[conn.id] = store.legacyByName[name]
    }
    delete store.legacyByName[name]
    migrated += 1
  }

  if (migrated > 0) writeStore(store)
  return { migrated }
}
