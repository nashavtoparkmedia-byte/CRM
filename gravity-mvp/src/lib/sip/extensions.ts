/**
 * Mapping between CRM user ids (u1, u2, ...) from src/data/users.json and
 * SIP extensions defined in telephony/conf/directory/default/*.xml.
 *
 * Each manager gets one extension that they use both from Linphone on their
 * phone and from the CRM browser softphone. Forking in the inbound dialplan
 * rings all of them simultaneously.
 *
 * Add a new manager: create their entry in users.json with id "uN", add
 * a matching extension in telephony/conf/directory/default/NNN.xml, then
 * register the pair here.
 */

export interface SipExtension {
    extension: string
    password: string
}

const EXTENSIONS: Record<string, SipExtension> = {
    u1: { extension: '101', password: process.env.MANAGER_101_PASSWORD ?? '' },
    u2: { extension: '102', password: process.env.MANAGER_102_PASSWORD ?? '' },
    // Match the password configured in
    // /usr/local/freeswitch/conf/directory/default/103.xml (the FS profile
    // for this extension). On rotation update both — env here AND the xml.
    u3: { extension: '103', password: process.env.MANAGER_103_PASSWORD ?? '' },
}

export function getSipExtensionForUser(userId: string): SipExtension | null {
    return EXTENSIONS[userId] ?? null
}

/** All known extensions, used by the inbound dialplan helper and stats. */
export function listExtensions(): string[] {
    return Object.values(EXTENSIONS).map(e => e.extension)
}
