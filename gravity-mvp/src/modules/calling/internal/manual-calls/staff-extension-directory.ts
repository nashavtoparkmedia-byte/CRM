// The SIP extension assigned to each employee, server-side only and without any credential.
//
// The authoritative assignment lives in lib/sip/extensions.ts together with the softphone
// passwords; that module is deliberately not imported here so a manual call never reaches a SIP
// credential. staff-extension-directory.test.ts fails the moment the two disagree.
const STAFF_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  u1: '101',
  u2: '102',
  u3: '103',
})

export function staffExtensionForV1(userId: string): string | null {
  return Object.prototype.hasOwnProperty.call(STAFF_EXTENSIONS, userId) ? STAFF_EXTENSIONS[userId] : null
}

export function staffExtensionDirectoryV1(): Readonly<Record<string, string>> {
  return STAFF_EXTENSIONS
}
