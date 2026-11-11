import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// No dialplan may route a call to the Megafon trunk. External calls are placed only by the CRM
// over ESL, after Calling's verified-destination policy; a softphone, Linphone or a stolen extension
// cannot dial an arbitrary number (Owner decision Q4, closes toll fraud through an extension).
const repo = path.resolve(__dirname, '../../../../../..')
const roots = ['telephony/conf/dialplan', 'tools/fs-config'].map(root => path.join(repo, root))

function xmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? xmlFiles(full) : full.endsWith('.xml') ? [full] : []
  })
}

const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/gu, '')

describe('telephony dialplan', () => {
  const files = roots.flatMap(xmlFiles)

  it('covers the deployed dialplan', () => {
    expect(files.some(file => file.endsWith('03_user_outbound.xml'))).toBe(true)
    expect(files.some(file => file.endsWith('02_megafon_inbound.xml'))).toBe(true)
  })

  it.each(files.map(file => [path.relative(repo, file), file]))('%s never bridges or transfers to the trunk', (_name, file) => {
    const xml = withoutComments(readFileSync(file, 'utf8'))
    expect(xml).not.toMatch(/sofia\/gateway\//u)
    expect(xml).not.toMatch(/name="user_outbound_megafon"/u)
  })

  it('keeps extension-to-extension calls', () => {
    const outbound = withoutComments(readFileSync(path.join(repo, 'telephony/conf/dialplan/default/03_user_outbound.xml'), 'utf8'))
    expect(outbound).toMatch(/<extension name="user_internal">/u)
    expect(outbound).toMatch(/data="user\/\$1"/u)
  })
})
