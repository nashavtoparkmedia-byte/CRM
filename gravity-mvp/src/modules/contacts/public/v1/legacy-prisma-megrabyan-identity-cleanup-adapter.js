/* eslint-disable @typescript-eslint/no-require-imports */

const { runContactOwnershipMaintenance } = require('../../internal/contact-ownership-maintenance-runtime')

const REAL_PHONE_ID = 'cmnjf1h8n09sjvp080h2z4pmm'
const LID_IDENTITY_ID = 'cmpgm9ku500g5vpc0p9f4a5l1'
const CUS_IDENTITY_ID = 'cmping75o000xvpp055983rua'

function cleanupMegrabyanIdentitiesV1() {
  return runContactOwnershipMaintenance(
    { identityIds: [LID_IDENTITY_ID, CUS_IDENTITY_ID], phoneIds: [REAL_PHONE_ID] },
    async transaction => {
      const lidIdentity = await transaction.contactIdentity.findUnique({ where: { id: LID_IDENTITY_ID } })
      const phone = await transaction.contactPhone.findUnique({ where: { id: REAL_PHONE_ID } })
      if (!lidIdentity || !phone || lidIdentity.contactId !== phone.contactId) {
        throw new Error('Megrabyan repair phone is not owned by the identity Contact')
      }
      const lid = await transaction.contactIdentity.update({
        where: { id: LID_IDENTITY_ID },
        data: { phoneId: REAL_PHONE_ID },
      })
      const cus = await transaction.contactIdentity.update({
        where: { id: CUS_IDENTITY_ID },
        data: { isActive: false, phoneId: null },
      })
      return { lid, cus }
    },
  )
}

module.exports = { cleanupMegrabyanIdentitiesV1 }
