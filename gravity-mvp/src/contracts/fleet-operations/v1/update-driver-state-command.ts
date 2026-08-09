export const UPDATE_DRIVER_STATE_COMMAND_V1 = 'fleet_operations.UpdateDriverStateCommand.v1' as const
export const UPDATE_DRIVER_STATE_RESULT_V1 = 'fleet_operations.UpdateDriverStateResult.v1' as const
export const RESOLVE_DRIVER_ATTENTION_V1 = 'resolve_driver_attention' as const
export type DriverAttentionResolutionStatusV1 = 'resolved' | 'not_found' | 'already_resolved'

export interface UpdateDriverStateCommandV1 { contract: typeof UPDATE_DRIVER_STATE_COMMAND_V1; operation: typeof RESOLVE_DRIVER_ATTENTION_V1; attentionId: string; resolvedBy: string | null }
export interface UpdateDriverStateResultV1 { contract: typeof UPDATE_DRIVER_STATE_RESULT_V1; status: DriverAttentionResolutionStatusV1; attention: null | { id: string; status: 'resolved'; resolvedAt: string | null } }
export class UpdateDriverStateValidationError extends Error { readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'; constructor(code: UpdateDriverStateValidationError['code'], message: string) { super(message); this.name='UpdateDriverStateValidationError'; this.code=code } }
const FIELDS=new Set(['contract','operation','attentionId','resolvedBy'])
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
function invalid(message:string):never{throw new UpdateDriverStateValidationError('INVALID_CONTRACT',message)}
export function parseUpdateDriverStateCommandV1(input:unknown):UpdateDriverStateCommandV1{
 if(!isRecord(input))invalid('command must be an object')
 const unexpected=Object.keys(input).filter(k=>!FIELDS.has(k));if(unexpected.length)invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
 if(input.contract!==UPDATE_DRIVER_STATE_COMMAND_V1){if(typeof input.contract==='string'&&input.contract.startsWith('fleet_operations.UpdateDriverStateCommand.'))throw new UpdateDriverStateValidationError('UNSUPPORTED_CONTRACT_VERSION',`unsupported contract version: ${input.contract}`);invalid(`contract must equal ${UPDATE_DRIVER_STATE_COMMAND_V1}`)}
 if(input.operation!==RESOLVE_DRIVER_ATTENTION_V1)invalid('operation is invalid')
 if(typeof input.attentionId!=='string'||input.attentionId.trim()==='')invalid('attentionId is required')
 if(input.resolvedBy!==null&&typeof input.resolvedBy!=='string')invalid('resolvedBy must be a string or null')
 return input as unknown as UpdateDriverStateCommandV1
}
