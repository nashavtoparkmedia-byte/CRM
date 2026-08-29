import { prisma } from '@/lib/prisma'
import type {
  AiAgentConfigPatchEntryV1,
  ExtractionQualityTierV1,
} from '../../../../contracts/calling/v1'
import type { AiAgentConfigPersistencePortV1 } from './ai-agent-config-handler'
import { revealAiAgentProviderCredentialV1 } from '../../application/ai-agent-provider-credential'

const BIND_ORDER = [
  'enabled',
  'mode',
  'provider',
  'providerCredential',
  'classificationModel',
  'responseModel',
  'language',
  'confidenceThreshold',
  'maxAutoRepliesPerChat',
  'activeChannels',
  'escalationPolicy',
  'workingHours',
  'routingRules',
  'promptRole',
  'promptTone',
  'promptAllowed',
  'promptForbidden',
  'activeProfileId',
  'connectionStatus',
  'lastConnectionCheckAt',
  'extractionQualityTier',
  'extractionPromptVersion',
  'internEnabled',
] as const satisfies readonly AiAgentConfigPatchEntryV1['field'][]

function bindArguments(entries: readonly AiAgentConfigPatchEntryV1[]): unknown[] {
  const byField = new Map(entries.map((entry) => [entry.field, entry] as const))
  const args: unknown[] = []
  for (const field of BIND_ORDER) {
    const entry = byField.get(field)
    args.push(entry !== undefined)
    if (entry?.field === 'providerCredential' && entry.value !== null) {
      args.push(revealAiAgentProviderCredentialV1(entry.value))
    } else {
      args.push(entry?.value ?? null)
    }
  }
  return args
}

export const legacyPrismaAiAgentConfigPortV1: AiAgentConfigPersistencePortV1 = {
  async singletonExists() {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1
    `
    return rows.length > 0
  },

  async createSingleton(entries) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiAgentConfig" (id, enabled, mode, provider, "apiKeyEncrypted", "classificationModel", "responseModel", language, "confidenceThreshold", "maxAutoRepliesPerChat", "activeChannels", "escalationPolicy", "workingHours", "routingRules", "promptRole", "promptTone", "promptAllowed", "promptForbidden", "activeProfileId", "connectionStatus", "lastConnectionCheckAt", "extractionQualityTier", "extractionPromptVersion", "internEnabled", "updatedAt") VALUES (\'singleton\', CASE WHEN $1::boolean THEN $2::boolean ELSE false END, CASE WHEN $3::boolean THEN $4::text::"AiAgentMode" ELSE \'off\'::"AiAgentMode" END, CASE WHEN $5::boolean THEN $6::text::"AiProviderType" ELSE \'anthropic\'::"AiProviderType" END, CASE WHEN $7::boolean THEN $8::text ELSE NULL::text END, CASE WHEN $9::boolean THEN $10::text ELSE \'claude-haiku-4-5\'::text END, CASE WHEN $11::boolean THEN $12::text ELSE \'claude-sonnet-4-5\'::text END, CASE WHEN $13::boolean THEN $14::text ELSE \'ru\'::text END, CASE WHEN $15::boolean THEN $16::double precision ELSE 0.75::double precision END, CASE WHEN $17::boolean THEN $18::integer ELSE 5::integer END, CASE WHEN $19::boolean THEN $20::text[] ELSE NULL::text[] END, CASE WHEN $21::boolean THEN $22::jsonb ELSE NULL::jsonb END, CASE WHEN $23::boolean THEN $24::jsonb ELSE NULL::jsonb END, CASE WHEN $25::boolean THEN $26::jsonb ELSE NULL::jsonb END, CASE WHEN $27::boolean THEN $28::text ELSE NULL::text END, CASE WHEN $29::boolean THEN $30::text ELSE NULL::text END, CASE WHEN $31::boolean THEN $32::text ELSE NULL::text END, CASE WHEN $33::boolean THEN $34::text ELSE NULL::text END, CASE WHEN $35::boolean THEN $36::text ELSE NULL::text END, CASE WHEN $37::boolean THEN $38::text ELSE NULL::text END, CASE WHEN $39::boolean THEN $40::timestamp(3) ELSE NULL::timestamp(3) END, CASE WHEN $41::boolean THEN $42::text ELSE \'balanced\'::text END, CASE WHEN $43::boolean THEN $44::text ELSE NULL::text END, CASE WHEN $45::boolean THEN $46::boolean ELSE true END, NOW())',
      ...bindArguments(entries),
    )
  },

  async updateSingleton(entries) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiAgentConfig" SET enabled = CASE WHEN $1::boolean THEN $2::boolean ELSE enabled END, mode = CASE WHEN $3::boolean THEN $4::text::"AiAgentMode" ELSE mode END, provider = CASE WHEN $5::boolean THEN $6::text::"AiProviderType" ELSE provider END, "apiKeyEncrypted" = CASE WHEN $7::boolean THEN $8::text ELSE "apiKeyEncrypted" END, "classificationModel" = CASE WHEN $9::boolean THEN $10::text ELSE "classificationModel" END, "responseModel" = CASE WHEN $11::boolean THEN $12::text ELSE "responseModel" END, language = CASE WHEN $13::boolean THEN $14::text ELSE language END, "confidenceThreshold" = CASE WHEN $15::boolean THEN $16::double precision ELSE "confidenceThreshold" END, "maxAutoRepliesPerChat" = CASE WHEN $17::boolean THEN $18::integer ELSE "maxAutoRepliesPerChat" END, "activeChannels" = CASE WHEN $19::boolean THEN $20::text[] ELSE "activeChannels" END, "escalationPolicy" = CASE WHEN $21::boolean THEN $22::jsonb ELSE "escalationPolicy" END, "workingHours" = CASE WHEN $23::boolean THEN $24::jsonb ELSE "workingHours" END, "routingRules" = CASE WHEN $25::boolean THEN $26::jsonb ELSE "routingRules" END, "promptRole" = CASE WHEN $27::boolean THEN $28::text ELSE "promptRole" END, "promptTone" = CASE WHEN $29::boolean THEN $30::text ELSE "promptTone" END, "promptAllowed" = CASE WHEN $31::boolean THEN $32::text ELSE "promptAllowed" END, "promptForbidden" = CASE WHEN $33::boolean THEN $34::text ELSE "promptForbidden" END, "activeProfileId" = CASE WHEN $35::boolean THEN $36::text ELSE "activeProfileId" END, "connectionStatus" = CASE WHEN $37::boolean THEN $38::text ELSE "connectionStatus" END, "lastConnectionCheckAt" = CASE WHEN $39::boolean THEN $40::timestamp(3) ELSE "lastConnectionCheckAt" END, "extractionQualityTier" = CASE WHEN $41::boolean THEN $42::text ELSE "extractionQualityTier" END, "extractionPromptVersion" = CASE WHEN $43::boolean THEN $44::text ELSE "extractionPromptVersion" END, "internEnabled" = CASE WHEN $45::boolean THEN $46::boolean ELSE "internEnabled" END, "updatedAt" = NOW() WHERE id = \'singleton\'',
      ...bindArguments(entries),
    )
  },

  async recordSavedConnectionSuccess() {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiAgentConfig" SET "connectionStatus" = \'ok\', "lastConnectionCheckAt" = NOW() WHERE id = \'singleton\'',
    )
  },

  async findProfile(profileId) {
    return prisma.aiAgentProfile.findUnique({ where: { id: profileId }, select: { id: true } })
  },

  async setActiveProfile(profileId) {
    await prisma.aiAgentConfig.upsert({
      where: { id: 'singleton' },
      update: { activeProfileId: profileId },
      create: { id: 'singleton', activeProfileId: profileId, activeChannels: [] },
    })
  },

  async saveExtractionQualityTier(tier: ExtractionQualityTierV1) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiAgentConfig" SET "extractionQualityTier" = $1::text, "updatedAt" = NOW() WHERE id = \'singleton\'',
      tier,
    )
  },
}
