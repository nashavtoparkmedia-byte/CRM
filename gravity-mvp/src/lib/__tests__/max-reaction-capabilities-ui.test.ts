import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('MAX reaction capability UI contract', () => {
    it('loads provider capabilities and keeps a safe MAX-only fallback', () => {
        const source = readFileSync(join(
            root,
            'src/app/messages/components/MessageContextMenu.tsx',
        ), 'utf8')

        expect(source).toContain("/api/messages/reaction?channel=max")
        expect(source).toContain('MAX_REACTION_FALLBACK')
        expect(source).toContain("msg.channel === 'max'")
        expect(source).toContain('quickEmojis')
        expect(source).not.toContain('MAX_QUICK_EMOJIS = QUICK_EMOJIS')
    })

    it('does not persist MAX metadata before provider confirmation', () => {
        const source = readFileSync(join(
            root,
            'src/app/api/messages/reaction/route.ts',
        ), 'utf8')
        const maxBranch = source.slice(
            source.indexOf("if (msg.channel === 'max')"),
            source.indexOf('const updated = await prisma.message.update'),
        )

        expect(maxBranch).toContain('reactionConfirmed')
        expect(maxBranch).toContain('status: 202')
        expect(maxBranch).not.toContain('prisma.message.update')
    })
})
