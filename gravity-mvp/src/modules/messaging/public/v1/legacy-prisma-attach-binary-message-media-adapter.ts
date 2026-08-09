import{prisma}from'@/lib/prisma';import type{AttachBinaryMessageMediaPersistencePortV1}from'./attach-binary-message-media-handler'
type LegacyBinaryAttachmentClient={messageAttachment:{create(input:{data:{messageId:string;type:string;mimeType:string;fileName:string|null;fileSize:number;data:Uint8Array}}):Promise<unknown>}}
const legacyPrisma=prisma as unknown as LegacyBinaryAttachmentClient
export const legacyPrismaAttachBinaryMessageMediaPortV1:AttachBinaryMessageMediaPersistencePortV1={async attach(input){await legacyPrisma.messageAttachment.create({data:{messageId:input.messageId,type:input.mediaType,mimeType:input.mimeType,fileName:input.fileName,fileSize:input.data.byteLength,data:input.data}})}}
