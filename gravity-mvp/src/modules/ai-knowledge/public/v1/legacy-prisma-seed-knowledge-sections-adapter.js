/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const SECTION_FIELDS = ['slug', 'title', 'description', 'iconKey', 'sortOrder']

function validateSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) throw new TypeError('sections must be a non-empty array')
  for (const section of sections) {
    if (!section || typeof section !== 'object' || Object.keys(section).some((key) => !SECTION_FIELDS.includes(key))) {
      throw new TypeError('section contains an unsupported field')
    }
    if (typeof section.slug !== 'string' || section.slug.length === 0) throw new TypeError('section.slug must be a non-empty string')
  }
}

/**
 * Fixed AI Knowledge-owned seed capability. Only AiKnowledgeSection is
 * reachable and only the documented upsert fields are accepted.
 */
async function seedKnowledgeSectionsV1(sections) {
  validateSections(sections)
  let created = 0
  let updated = 0
  for (const section of sections) {
    const existing = await prisma.aiKnowledgeSection.findUnique({ where: { slug: section.slug }, select: { id: true } })
    if (!existing) {
      const id = `sec_${section.slug}_${Date.now()}`
      await prisma.aiKnowledgeSection.create({
        data: {
          id,
          slug: section.slug,
          title: section.title,
          description: section.description,
          iconKey: section.iconKey,
          sortOrder: section.sortOrder,
          isActive: true,
        },
      })
      created += 1
    } else {
      await prisma.aiKnowledgeSection.update({
        where: { slug: section.slug },
        data: {
          description: section.description,
          iconKey: section.iconKey,
          sortOrder: section.sortOrder,
        },
      })
      updated += 1
    }
  }
  return { created, updated }
}

module.exports = { seedKnowledgeSectionsV1 }
