'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    AUDIO_CONTRACT,
    FrameProtocolError,
    HEADER_BYTES,
    crc32,
    decodeAudioFrame,
    deterministicPcmFrame,
    encodeAudioFrame,
} = require('../scripts/dev-loopback/protocol')

test('canonical audio contract is 8 kHz mono PCM S16LE in 20 ms frames', () => {
    assert.equal(AUDIO_CONTRACT.codec, 'pcm_s16le')
    assert.equal(AUDIO_CONTRACT.sampleRate, 8000)
    assert.equal(AUDIO_CONTRACT.channels, 1)
    assert.equal(AUDIO_CONTRACT.bytesPerSample, 2)
    assert.equal(AUDIO_CONTRACT.frameDurationMs, 20)
    assert.equal(AUDIO_CONTRACT.samplesPerFrame, 160)
    assert.equal(AUDIO_CONTRACT.bytesPerFrame, 320)
})

test('YALB envelope round-trips exact sequence, timestamp, checksum and PCM', () => {
    const payload = deterministicPcmFrame(17, 4)
    const encoded = encodeAudioFrame({
        sequence: 17,
        payload,
        sentAtMs: 1_784_950_000_000,
        flags: 3,
    })
    const decoded = decodeAudioFrame(encoded)

    assert.equal(encoded.length, HEADER_BYTES + AUDIO_CONTRACT.bytesPerFrame)
    assert.equal(decoded.sequence, 17)
    assert.equal(decoded.flags, 3)
    assert.equal(decoded.payloadLength, 320)
    assert.equal(decoded.sentAtMs, 1_784_950_000_000)
    assert.equal(decoded.checksum, crc32(payload))
    assert.ok(decoded.payload.equals(payload))
})

test('deterministic fixture changes with sequence and session seed', () => {
    const first = deterministicPcmFrame(0, 10)
    const next = deterministicPcmFrame(1, 10)
    const otherSession = deterministicPcmFrame(0, 11)

    assert.ok(!first.equals(next))
    assert.ok(!first.equals(otherSession))
    assert.ok(first.equals(deterministicPcmFrame(0, 10)))
})

test('CRC32 implementation matches the standard reference vector', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('malformed envelope, length and checksum have stable sanitized codes', () => {
    assert.throws(
        () => decodeAudioFrame(Buffer.alloc(4)),
        error => error instanceof FrameProtocolError && error.code === 'frame_too_short',
    )

    const checksumBad = encodeAudioFrame({
        sequence: 0,
        payload: deterministicPcmFrame(0, 0),
    })
    checksumBad[checksumBad.length - 1] ^= 0xff
    assert.throws(
        () => decodeAudioFrame(checksumBad),
        error => error instanceof FrameProtocolError && error.code === 'checksum_mismatch',
    )

    const lengthBad = encodeAudioFrame({
        sequence: 0,
        payload: deterministicPcmFrame(0, 0),
    })
    lengthBad.writeUInt32LE(319, 12)
    assert.throws(
        () => decodeAudioFrame(lengthBad),
        error => error instanceof FrameProtocolError && error.code === 'payload_length_mismatch',
    )
})

test('encoder refuses non-canonical chunk size before transport', () => {
    assert.throws(
        () => encodeAudioFrame({ sequence: 0, payload: Buffer.alloc(318) }),
        error => error instanceof FrameProtocolError && error.code === 'payload_size_invalid',
    )
})

test('encoder rejects flags outside the uint16 envelope field sanitarily', () => {
    assert.throws(
        () => encodeAudioFrame({
            sequence: 0,
            payload: deterministicPcmFrame(0, 0),
            flags: 0x1_0000,
        }),
        error => error instanceof FrameProtocolError && error.code === 'flags_invalid',
    )
})
