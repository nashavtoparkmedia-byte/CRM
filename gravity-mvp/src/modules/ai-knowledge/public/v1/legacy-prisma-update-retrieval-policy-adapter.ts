import { prisma } from '@/lib/prisma'
import { RETRIEVAL_POLICY_FIELDS_V1 } from '../../../../contracts/ai-knowledge/v1'
import type { UpdateRetrievalPolicyPersistencePortV1 } from './update-retrieval-policy-handler'
export const legacyPrismaUpdateRetrievalPolicyPortV1: UpdateRetrievalPolicyPersistencePortV1 = {
    async update(input) {
        const fields: string[] = []; const vals: unknown[] = []
        for (const key of RETRIEVAL_POLICY_FIELDS_V1) {
            if (input.patch[key] === undefined) continue
            fields.push(`"${key}" = $${fields.length + 1}`); vals.push(input.patch[key])
        }
        fields.push('"updatedAt" = NOW()'); fields.push(`"updatedBy" = $${vals.length + 1}`); vals.push(input.actorId)
        await prisma.$executeRawUnsafe(`UPDATE "AiRetrievalPolicy" SET ${fields.join(', ')} WHERE id = 'singleton'`, ...vals)
    },
}
