/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const PROFILE_FIELDS = [
  'name', 'description', 'promptRole', 'promptTone', 'promptAllowed', 'promptForbidden',
  'isDefault', 'sortOrder',
]

function validateProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) throw new TypeError('profiles must be a non-empty array')
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Object.keys(profile).some((key) => !PROFILE_FIELDS.includes(key))) {
      throw new TypeError('profile contains an unsupported field')
    }
    if (typeof profile.name !== 'string' || profile.name.length === 0) throw new TypeError('profile.name must be a non-empty string')
  }
}

/**
 * Fixed Calling-owned maintenance capability for the default profile seed.
 * The capability exposes no model/client handle and accepts only the closed
 * profile field set above; unrelated writes cannot be smuggled through it.
 */
async function seedAiProfilesV1(profiles) {
  validateProfiles(profiles)
  const created = []
  for (const profile of profiles) {
    const existing = await prisma.aiAgentProfile.findFirst({ where: { name: profile.name } })
    if (existing) {
      created.push(existing)
      continue
    }
    created.push(await prisma.aiAgentProfile.create({ data: profile }))
  }

  const config = await prisma.aiAgentConfig.findUnique({ where: { id: 'singleton' } })
  let configStatus = 'missing'
  if (config?.activeProfileId) configStatus = 'already_selected'
  else if (config && created[0]) {
    await prisma.aiAgentConfig.update({
      where: { id: 'singleton' },
      data: { activeProfileId: created[0].id },
    })
    configStatus = 'selected'
  }
  return { created, configStatus }
}

module.exports = { seedAiProfilesV1 }
