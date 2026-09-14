/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const {
  runContactOwnershipMaintenance,
  updateIdentity,
} = require('../../internal/contact-ownership-maintenance-runtime')

function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a bounded non-empty string`)
  }
}
function validateDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('checkedAt must be valid')
}

async function updateContactIdentityReachabilityV1(id, status, checkedAt) {
  validateId(id, 'id')
  validateId(status, 'status')
  validateDate(checkedAt)
  const prisma = new PrismaClient()
  try {
    return await prisma.contactIdentity.update({
      where: { id },
      data: { reachabilityStatus: status, reachabilityCheckedAt: checkedAt },
    })
  } finally {
    await prisma.$disconnect()
  }
}

function deactivateFakeContactIdentityV1(id) {
  validateId(id, 'id')
  return updateIdentity(id, null, { isActive: false, phoneId: null })
}

const REAL_PHONE_ID = 'cmnjf14sf01czvp08cb2qagcz'
const LID_IDENTITY_ID = 'cmphc72s3000hvpsksmgk55jr'
const CUS_IDENTITY_ID = 'cmph1e54l00ftvpm4ia9xlrvn'
function repointIsakovLidIdentityV1() {
  return updateIdentity(LID_IDENTITY_ID, REAL_PHONE_ID, { phoneId: REAL_PHONE_ID })
}
function deactivateIsakovCusIdentityV1() {
  return updateIdentity(CUS_IDENTITY_ID, null, { isActive: false, phoneId: null })
}

function repointOrDeactivateFakeIdentityV1(identityId, lid) {
  validateId(identityId, 'identityId')
  validateId(lid, 'lid')
  return runContactOwnershipMaintenance(
    {
      identityIds: [identityId],
      identities: [{ channel: 'whatsapp', providerAccountId: 'legacy', externalId: lid }],
    },
    async transaction => {
      const existing = await transaction.contactIdentity.findFirst({
        where: { channel: 'whatsapp', externalId: lid },
      })
      return transaction.contactIdentity.update({
        where: { id: identityId },
        data: existing ? { isActive: false, phoneId: null } : { externalId: lid, phoneId: null },
      })
    },
  )
}

function setContactIdentityPhoneV1(identityId, phoneId) {
  validateId(identityId, 'identityId')
  if (phoneId !== null) validateId(phoneId, 'phoneId')
  return updateIdentity(identityId, phoneId, { phoneId })
}

function deactivateContactIdentityByExternalIdV1(contactId, externalId) {
  validateId(contactId, 'contactId')
  validateId(externalId, 'externalId')
  return runContactOwnershipMaintenance(
    {
      contactIds: [contactId],
      identities: [{ contactId, channel: 'whatsapp', providerAccountId: 'legacy', externalId }],
    },
    transaction => transaction.contactIdentity.updateMany({
      where: {
        contactId,
        channel: 'whatsapp',
        externalId,
        isActive: true,
      },
      data: { isActive: false, phoneId: null },
    }),
  )
}

module.exports = {
  updateContactIdentityReachabilityV1,
  deactivateFakeContactIdentityV1,
  repointIsakovLidIdentityV1,
  deactivateIsakovCusIdentityV1,
  repointOrDeactivateFakeIdentityV1,
  setContactIdentityPhoneV1,
  deactivateContactIdentityByExternalIdV1,
}
