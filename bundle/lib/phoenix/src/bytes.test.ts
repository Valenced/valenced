import { describe, expect, test } from 'vitest'
import { ByteReader, ByteWriter } from './bytes'

describe('fixed width integers', () => {
    test('round-trips u8, u16, u32 and f64', () => {
        const bytes = new ByteWriter()
            .u8(0xff)
            .u16(0xbeef)
            .u32(0xdeadbeef)
            .f64(-1.5e300)
            .toBytes()

        expect(bytes).toHaveLength(15)

        const reader = new ByteReader(bytes)
        expect(reader.u8()).toBe(0xff)
        expect(reader.u16()).toBe(0xbeef)
        expect(reader.u32()).toBe(0xdeadbeef)
        expect(reader.f64()).toBe(-1.5e300)
        expect(reader.remaining).toBe(0)
    })

    test('writes little-endian', () => {
        expect([...new ByteWriter().u32(1).toBytes()]).toEqual([1, 0, 0, 0])
    })
})

describe('varint', () => {
    const values = [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0xdeadbeef, 2 ** 53 - 1]

    test('round-trips boundary values', () => {
        const writer = new ByteWriter()
        for (const value of values) writer.varint(value)

        const reader = new ByteReader(writer.toBytes())
        expect(values.map(() => reader.varint())).toEqual(values)
    })

    test('uses one byte below 128', () => {
        expect(new ByteWriter().varint(0x7f).length).toBe(1)
        expect(new ByteWriter().varint(0x80).length).toBe(2)
    })

    test('rejects values it cannot round-trip', () => {
        expect(() => new ByteWriter().varint(-1)).toThrow(/out of range/)
        expect(() => new ByteWriter().varint(1.5)).toThrow(/out of range/)
        expect(() => new ByteWriter().varint(2 ** 53)).toThrow(/out of range/)
    })
})

describe('length-prefixed bytes', () => {
    test('round-trips an empty payload', () => {
        const reader = new ByteReader(
            new ByteWriter().bytes(new Uint8Array()).toBytes(),
        )
        expect(reader.bytes()).toHaveLength(0)
    })

    test('round-trips a payload past the initial buffer', () => {
        const payload = new Uint8Array(1000).map((_, i) => i & 0xff)
        const reader = new ByteReader(new ByteWriter().bytes(payload).toBytes())
        expect(reader.bytes()).toEqual(payload)
    })

    test('keeps fields after it readable', () => {
        const bytes = new ByteWriter()
            .bytes(new Uint8Array([1, 2, 3]))
            .u16(7)
            .toBytes()

        const reader = new ByteReader(bytes)
        expect([...reader.bytes()]).toEqual([1, 2, 3])
        expect(reader.u16()).toBe(7)
    })
})

describe('length-prefixed utf8', () => {
    const strings = [
        '',
        'MESSAGE_CREATE',
        'ascii with spaces',
        'café',
        'éő中文',
        '\u{1f5bb}\u{1f600}',
        'mixed 中文 and \u{1f600}',
        '\ud800',
    ]

    test.each(strings)('round-trips %j', value => {
        const reader = new ByteReader(new ByteWriter().string(value).toBytes())
        expect(reader.string()).toBe(value)
        expect(reader.remaining).toBe(0)
    })

    test('prefixes the byte length, not the character count', () => {
        // Four bytes of UTF-8 plus a one byte length.
        expect(new ByteWriter().string('\u{1f600}').length).toBe(5)
    })
})

describe('bounds', () => {
    test('throws past the end of the frame', () => {
        const reader = new ByteReader(new Uint8Array([1]))
        expect(reader.u8()).toBe(1)
        expect(() => reader.u8()).toThrow(/Frame ended/)
    })

    test('throws when a length prefix lies', () => {
        expect(() => new ByteReader(new Uint8Array([4, 1, 2])).bytes()).toThrow(
            /Frame ended/,
        )
    })
})
