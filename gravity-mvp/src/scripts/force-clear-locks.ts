import {
    CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1,
    CLEAR_FLEET_CHECK_STATUS_COMMAND_V1,
} from '@/contracts/fleet-operations/v1';
import { clearFleetCheckStatusV1 } from '@/modules/fleet-operations/public/v1';

async function main() {
    console.log('Force clearing all CRM driver lock statuses...');
    await clearFleetCheckStatusV1({
        contract: CLEAR_FLEET_CHECK_STATUS_COMMAND_V1,
        operation: CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1,
    });
}

main()
    .catch(console.error);
