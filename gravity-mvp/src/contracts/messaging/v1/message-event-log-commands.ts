export const CLAIM_MESSAGE_EVENT_COMMAND_V1='messaging.ClaimMessageEventCommand.v1' as const
export const CLAIM_MESSAGE_EVENT_RESULT_V1='messaging.ClaimMessageEventResult.v1' as const
export const COMPLETE_MESSAGE_EVENT_COMMAND_V1='messaging.CompleteMessageEventCommand.v1' as const
export const COMPLETE_MESSAGE_EVENT_RESULT_V1='messaging.CompleteMessageEventResult.v1' as const
export const FAIL_MESSAGE_EVENT_COMMAND_V1='messaging.FailMessageEventCommand.v1' as const
export const FAIL_MESSAGE_EVENT_RESULT_V1='messaging.FailMessageEventResult.v1' as const
export interface ClaimMessageEventCommandV1{contract:typeof CLAIM_MESSAGE_EVENT_COMMAND_V1;messageId:string}
export interface ClaimMessageEventResultV1{contract:typeof CLAIM_MESSAGE_EVENT_RESULT_V1;claimed:boolean}
export interface CompleteMessageEventCommandV1{contract:typeof COMPLETE_MESSAGE_EVENT_COMMAND_V1;messageId:string}
export interface CompleteMessageEventResultV1{contract:typeof COMPLETE_MESSAGE_EVENT_RESULT_V1;completed:true}
export interface FailMessageEventCommandV1{contract:typeof FAIL_MESSAGE_EVENT_COMMAND_V1;messageId:string}
export interface FailMessageEventResultV1{contract:typeof FAIL_MESSAGE_EVENT_RESULT_V1;failed:true}
export class MessageEventLogCommandValidationError extends Error{readonly code:'INVALID_CONTRACT'|'UNSUPPORTED_CONTRACT_VERSION';constructor(code:MessageEventLogCommandValidationError['code'],message:string){super(message);this.name='MessageEventLogCommandValidationError';this.code=code}}
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);function invalid(m:string):never{throw new MessageEventLogCommandValidationError('INVALID_CONTRACT',m)}function parse(input:unknown,expected:string,prefix:string):{contract:string;messageId:string}{if(!isRecord(input))invalid('command must be an object');const extra=Object.keys(input).filter(k=>k!=='contract'&&k!=='messageId');if(extra.length)invalid(`unsupported field(s): ${extra.sort().join(', ')}`);if(input.contract!==expected){if(typeof input.contract==='string'&&input.contract.startsWith(prefix))throw new MessageEventLogCommandValidationError('UNSUPPORTED_CONTRACT_VERSION',`unsupported contract version: ${input.contract}`);invalid(`contract must equal ${expected}`)}if(typeof input.messageId!=='string'||input.messageId.trim()==='')invalid('messageId is required');return input as{contract:string;messageId:string}}
export function parseClaimMessageEventCommandV1(input:unknown):ClaimMessageEventCommandV1{return parse(input,CLAIM_MESSAGE_EVENT_COMMAND_V1,'messaging.ClaimMessageEventCommand.')as ClaimMessageEventCommandV1}
export function parseCompleteMessageEventCommandV1(input:unknown):CompleteMessageEventCommandV1{return parse(input,COMPLETE_MESSAGE_EVENT_COMMAND_V1,'messaging.CompleteMessageEventCommand.')as CompleteMessageEventCommandV1}
export function parseFailMessageEventCommandV1(input:unknown):FailMessageEventCommandV1{return parse(input,FAIL_MESSAGE_EVENT_COMMAND_V1,'messaging.FailMessageEventCommand.')as FailMessageEventCommandV1}
