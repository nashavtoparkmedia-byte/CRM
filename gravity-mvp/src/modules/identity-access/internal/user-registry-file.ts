import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Storage of the CRM's one employee registry (Staff Session v1.3, D3).
 *
 * The registry itself is unchanged: the same `UserItem` records, read by
 * `getUsers()` and written by `/users`. What changes is only where the file
 * lives and how it is written:
 *
 * - `YOKO_USER_REGISTRY_FILE` names the file. Without it, and only while the
 *   staff lane is dormant, the in-image `src/data/users.json` is used, exactly
 *   as before.
 * - The image's file seeds a missing registry once (exclusive create), but
 *   only while dormant or under `YOKO_USER_REGISTRY_SEED=once` while no
 *   credential row exists (C-D3a, I-1). A configured lane never re-seeds
 *   silently: a forgotten volume mount must not bring back the build-time
 *   registry with its old roles.
 * - Writes are atomic per file: a temporary file in the same directory with
 *   the original's mode, fsync, rename, fsync of the directory (N-D3). One
 *   writer per instance; multi-instance deployment is not supported in v1.
 *
 * Nothing here claims atomicity between this file and PostgreSQL. The order
 * of writes in the staff operations is the mechanism (D2).
 */

export const IMAGE_REGISTRY_PATH_V1 = path.join(process.cwd(), 'src/data/users.json')

export interface RegistryEnvironmentV1 {
    YOKO_USER_REGISTRY_FILE?: string
    YOKO_USER_REGISTRY_SEED?: string
}

export interface RegistryRecordV1 {
    id: string
    firstName: string
    lastName: string
    email?: string
    phone?: string
    role: 'Менеджер' | 'Руководитель' | 'Администратор'
    status: 'Активен' | 'Отключен'
    createdAt: string
}

export type RegistryLocationV1 =
    | { ok: true, path: string }
    | { ok: false, reason: 'registry_file_unset' | 'registry_file_missing' | 'registry_seed_refused' | 'registry_unreadable' }

function environment(): RegistryEnvironmentV1 {
    return process.env as unknown as RegistryEnvironmentV1
}

const reportedRefusals = new Set<string>()

function reportOnce(reason: string): void {
    if (reportedRefusals.has(reason)) return
    reportedRefusals.add(reason)
    console.error(`[staff-session] the staff lane refuses: ${reason} (registry storage, docs/design/staff-session-v1.md C-D3a)`)
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file, fsConstants.F_OK)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
        throw error
    }
}

/** Copy the image registry to `target` only if `target` does not exist (exclusive create). */
async function seedFromImage(target: string): Promise<void> {
    if (path.resolve(target) === path.resolve(IMAGE_REGISTRY_PATH_V1)) return
    const seed = await fs.readFile(IMAGE_REGISTRY_PATH_V1)
    await fs.mkdir(path.dirname(target), { recursive: true })
    let handle: fs.FileHandle | null = null
    try {
        handle = await fs.open(target, 'wx', 0o640)
        await handle.writeFile(seed)
        await handle.sync()
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return
        throw error
    } finally {
        await handle?.close()
    }
    console.warn(`[staff-session] user registry seeded from the image at first start`)
}

/**
 * Where the registry is, for this lane state. `laneConfigured` is the one
 * secret-validity predicate (C-D4b); `anyCredentialRow` is asked only when a
 * seed under the one-time flag is considered.
 */
export async function locateRegistryV1(input: {
    laneConfigured: boolean
    anyCredentialRow: () => Promise<boolean>
}, env: RegistryEnvironmentV1 = environment()): Promise<RegistryLocationV1> {
    const configured = env.YOKO_USER_REGISTRY_FILE?.trim() || ''
    try {
        if (!input.laneConfigured) {
            // Dormant: today's behaviour, or a first-start seed of a named file.
            if (configured === '') return { ok: true, path: IMAGE_REGISTRY_PATH_V1 }
            if (!(await exists(configured))) await seedFromImage(configured)
            return { ok: true, path: configured }
        }
        if (configured === '') {
            reportOnce('registry_file_unset')
            return { ok: false, reason: 'registry_file_unset' }
        }
        if (await exists(configured)) return { ok: true, path: configured }
        if (env.YOKO_USER_REGISTRY_SEED !== 'once') {
            reportOnce('registry_file_missing')
            return { ok: false, reason: 'registry_file_missing' }
        }
        // I-1: the flag is one-time mechanically — it works only while no
        // credential row exists, so a flag left in the environment cannot
        // re-seed after the lane has been used.
        if (await input.anyCredentialRow()) {
            reportOnce('registry_seed_refused')
            return { ok: false, reason: 'registry_seed_refused' }
        }
        await seedFromImage(configured)
        return { ok: true, path: configured }
    } catch {
        reportOnce('registry_unreadable')
        return { ok: false, reason: 'registry_unreadable' }
    }
}

const ROLES = new Set(['Менеджер', 'Руководитель', 'Администратор'])
const STATUSES = new Set(['Активен', 'Отключен'])

function isRecord(value: unknown): value is RegistryRecordV1 {
    if (value === null || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return typeof record.id === 'string'
        && typeof record.firstName === 'string'
        && typeof record.lastName === 'string'
        && typeof record.role === 'string' && ROLES.has(record.role)
        && typeof record.status === 'string' && STATUSES.has(record.status)
        && typeof record.createdAt === 'string'
}

/**
 * Read for authorization (C-D1a): throws on a missing file, an I/O error,
 * partial or non-array JSON. A malformed record is dropped, never coerced:
 * it simply does not exist for verification.
 */
export async function readRegistryStrictV1(file: string): Promise<RegistryRecordV1[]> {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new TypeError('registry is not an array')
    return parsed.filter(isRecord)
}

/**
 * Read for a write: every record exactly as stored, malformed ones included,
 * so a write never drops what it did not understand. Throws like the strict
 * read on a missing file, an I/O error or non-array JSON.
 */
export async function readRegistryForWriteV1(file: string): Promise<unknown[]> {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new TypeError('registry is not an array')
    return parsed
}

/** Whether a stored entry is a well-formed registry record. */
export function isRegistryRecordV1(value: unknown): value is RegistryRecordV1 {
    return isRecord(value)
}

/** Read for display, as `getUsers()` always did: nothing on any error. */
export async function readRegistryLenientV1(file: string): Promise<RegistryRecordV1[]> {
    try {
        const raw = await fs.readFile(file, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed as RegistryRecordV1[] : []
    } catch {
        return []
    }
}

let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Serialize read-modify-write of the registry inside this instance. The
 * callback reads, decides and calls `writeRegistryAtomicV1` while it holds
 * the turn.
 */
export function withRegistryWriteTurnV1<T>(work: () => Promise<T>): Promise<T> {
    const run = writeChain.then(work, work)
    writeChain = run.catch(() => undefined)
    return run
}

/** Atomic replacement of the registry file (N-D3). */
export async function writeRegistryAtomicV1(file: string, records: readonly unknown[]): Promise<void> {
    const directory = path.dirname(file)
    let mode = 0o640
    try {
        mode = (await fs.stat(file)).mode & 0o777
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const temporary = path.join(directory, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
    let handle: fs.FileHandle | null = null
    try {
        handle = await fs.open(temporary, 'wx', mode)
        await handle.writeFile(JSON.stringify(records, null, 2), 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
        await fs.rename(temporary, file)
    } catch (error) {
        await handle?.close().catch(() => undefined)
        await fs.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
    let directoryHandle: fs.FileHandle | null = null
    try {
        directoryHandle = await fs.open(directory, 'r')
        await directoryHandle.sync()
    } catch {
        // Some filesystems refuse fsync on a directory; the rename has happened.
    } finally {
        await directoryHandle?.close().catch(() => undefined)
    }
}
