'use strict'

const MAGIC = Buffer.from('YALB', 'ascii')
const VERSION = 1
const FRAME_TYPE_AUDIO = 1
const HEADER_BYTES = 28

const AUDIO_CONTRACT = Object.freeze({
    encoding: 'PCM signed 16-bit little-endian',
    codec: 'pcm_s16le',
    sampleRate: 8000,
    channels: 1,
    bytesPerSample: 2,
    frameDurationMs: 20,
    samplesPerFrame: 160,
    bytesPerFrame: 320,
    transport: 'WebSocket binary message with YALB v1 envelope',
    envelopeFields: Object.freeze([
        'magic',
        'version',
        'type',
        'flags',
        'sequence',
        'payloadLength',
        'crc32',
        'sentAtMs',
    ]),
})

class FrameProtocolError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'FrameProtocolError'
        this.code = code
    }
}

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0
            ? (0xedb88320 ^ (value >>> 1))
            : (value >>> 1)
    }
    CRC_TABLE[i] = value >>> 0
}

function crc32(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
    let crc = 0xffffffff
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

function assertUint32(value, field) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new FrameProtocolError(`${field}_invalid`)
    }
}

function assertUint16(value, field) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new FrameProtocolError(`${field}_invalid`)
    }
}

function encodeAudioFrame({
    sequence,
    payload,
    sentAtMs = Date.now(),
    flags = 0,
} = {}) {
    assertUint32(sequence, 'sequence')
    assertUint16(flags, 'flags')
    if (!Buffer.isBuffer(payload)) {
        throw new FrameProtocolError('payload_not_buffer')
    }
    if (payload.length !== AUDIO_CONTRACT.bytesPerFrame) {
        throw new FrameProtocolError('payload_size_invalid')
    }
    if (!Number.isSafeInteger(sentAtMs) || sentAtMs <= 0) {
        throw new FrameProtocolError('timestamp_invalid')
    }

    const output = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
    MAGIC.copy(output, 0)
    output.writeUInt8(VERSION, 4)
    output.writeUInt8(FRAME_TYPE_AUDIO, 5)
    output.writeUInt16LE(flags, 6)
    output.writeUInt32LE(sequence, 8)
    output.writeUInt32LE(payload.length, 12)
    output.writeUInt32LE(crc32(payload), 16)
    output.writeBigUInt64LE(BigInt(sentAtMs), 20)
    payload.copy(output, HEADER_BYTES)
    return output
}

function decodeAudioFrame(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (buffer.length < HEADER_BYTES) {
        throw new FrameProtocolError('frame_too_short')
    }
    if (!buffer.subarray(0, 4).equals(MAGIC)) {
        throw new FrameProtocolError('bad_magic')
    }
    if (buffer.readUInt8(4) !== VERSION) {
        throw new FrameProtocolError('bad_version')
    }
    if (buffer.readUInt8(5) !== FRAME_TYPE_AUDIO) {
        throw new FrameProtocolError('bad_frame_type')
    }

    const flags = buffer.readUInt16LE(6)
    const sequence = buffer.readUInt32LE(8)
    const payloadLength = buffer.readUInt32LE(12)
    const expectedChecksum = buffer.readUInt32LE(16)
    const sentAtBigInt = buffer.readBigUInt64LE(20)
    if (sentAtBigInt > BigInt(Number.MAX_SAFE_INTEGER) || sentAtBigInt === 0n) {
        throw new FrameProtocolError('timestamp_invalid')
    }
    if (payloadLength !== buffer.length - HEADER_BYTES) {
        throw new FrameProtocolError('payload_length_mismatch')
    }
    if (payloadLength !== AUDIO_CONTRACT.bytesPerFrame) {
        throw new FrameProtocolError('payload_size_invalid')
    }

    const payload = Buffer.from(buffer.subarray(HEADER_BYTES))
    const actualChecksum = crc32(payload)
    if (actualChecksum !== expectedChecksum) {
        throw new FrameProtocolError('checksum_mismatch')
    }

    return {
        sequence,
        flags,
        payloadLength,
        checksum: actualChecksum,
        sentAtMs: Number(sentAtBigInt),
        payload,
    }
}

function deterministicPcmFrame(sequence, seed = 0) {
    assertUint32(sequence, 'sequence')
    assertUint32(seed, 'seed')
    const payload = Buffer.alloc(AUDIO_CONTRACT.bytesPerFrame)
    for (let sample = 0; sample < AUDIO_CONTRACT.samplesPerFrame; sample += 1) {
        const unsigned = (
            ((seed + 1) * 409)
            + ((sequence + 1) * 1009)
            + (sample * 131)
        ) & 0xffff
        payload.writeInt16LE(unsigned - 0x8000, sample * AUDIO_CONTRACT.bytesPerSample)
    }
    return payload
}

module.exports = {
    AUDIO_CONTRACT,
    FRAME_TYPE_AUDIO,
    FrameProtocolError,
    HEADER_BYTES,
    MAGIC,
    VERSION,
    crc32,
    decodeAudioFrame,
    deterministicPcmFrame,
    encodeAudioFrame,
}
