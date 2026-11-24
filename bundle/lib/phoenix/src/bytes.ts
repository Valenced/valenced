/** Little-endian byte writer with a growing buffer. */
export class ByteWriter {
    private buffer = new Uint8Array(64)
    private view = new DataView(this.buffer.buffer)
    private cursor = 0

    get length() {
        return this.cursor
    }

    u8(value: number) {
        this.reserve(1)
        this.buffer[this.cursor++] = value & 0xff
        return this
    }

    u16(value: number) {
        this.reserve(2)
        this.view.setUint16(this.cursor, value & 0xffff, true)
        this.cursor += 2
        return this
    }

    u32(value: number) {
        this.reserve(4)
        this.view.setUint32(this.cursor, value >>> 0, true)
        this.cursor += 4
        return this
    }

    i32(value: number) {
        this.reserve(4)
        this.view.setInt32(this.cursor, value, true)
        this.cursor += 4
        return this
    }

    i64(value: bigint) {
        this.reserve(8)
        this.view.setBigInt64(this.cursor, value, true)
        this.cursor += 8
        return this
    }

    f32(value: number) {
        this.reserve(4)
        this.view.setFloat32(this.cursor, value, true)
        this.cursor += 4
        return this
    }

    f64(value: number) {
        this.reserve(8)
        this.view.setFloat64(this.cursor, value, true)
        this.cursor += 8
        return this
    }

    /** Bytes with no length prefix. */
    raw(value: Uint8Array) {
        this.reserve(value.length)
        this.buffer.set(value, this.cursor)
        this.cursor += value.length
        return this
    }

    /** Unsigned LEB128. */
    varint(value: number) {
        if (
            !Number.isInteger(value) ||
            value < 0 ||
            value > Number.MAX_SAFE_INTEGER
        )
            throw new RangeError(`Varint out of range: ${value}`)

        let rest = value
        while (rest > 0x7f) {
            this.u8((rest & 0x7f) | 0x80)
            rest = Math.floor(rest / 0x80)
        }

        return this.u8(rest)
    }

    /** Varint length, then the raw bytes. */
    bytes(value: Uint8Array) {
        this.varint(value.length)
        return this.raw(value)
    }

    /** Varint byte length, then UTF-8. */
    string(value: string) {
        return this.bytes(encodeUtf8(value))
    }

    toBytes() {
        return this.buffer.slice(0, this.cursor)
    }

    private reserve(count: number) {
        const needed = this.cursor + count
        if (needed <= this.buffer.length) return

        let size = this.buffer.length * 2
        while (size < needed) size *= 2

        const grown = new Uint8Array(size)
        grown.set(this.buffer.subarray(0, this.cursor))
        this.buffer = grown
        this.view = new DataView(grown.buffer)
    }
}

/** Little-endian reader over a frame. Throws when a read runs past the end. */
export class ByteReader {
    private buffer: Uint8Array
    private view: DataView
    private cursor = 0

    constructor(bytes: Uint8Array) {
        this.buffer = bytes
        this.view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        )
    }

    get offset() {
        return this.cursor
    }

    get remaining() {
        return this.buffer.length - this.cursor
    }

    u8() {
        this.require(1)
        return this.buffer[this.cursor++]
    }

    u16() {
        this.require(2)
        const value = this.view.getUint16(this.cursor, true)
        this.cursor += 2
        return value
    }

    u32() {
        this.require(4)
        const value = this.view.getUint32(this.cursor, true)
        this.cursor += 4
        return value
    }

    i32() {
        this.require(4)
        const value = this.view.getInt32(this.cursor, true)
        this.cursor += 4
        return value
    }

    i64() {
        this.require(8)
        const value = this.view.getBigInt64(this.cursor, true)
        this.cursor += 8
        return value
    }

    f32() {
        this.require(4)
        const value = this.view.getFloat32(this.cursor, true)
        this.cursor += 4
        return value
    }

    f64() {
        this.require(8)
        const value = this.view.getFloat64(this.cursor, true)
        this.cursor += 8
        return value
    }

    /** Next [length] bytes, with no length prefix. */
    raw(length: number) {
        this.require(length)
        const value = this.buffer.slice(this.cursor, this.cursor + length)
        this.cursor += length
        return value
    }

    varint() {
        let value = 0
        let scale = 1

        for (;;) {
            const byte = this.u8()
            value += (byte & 0x7f) * scale
            if (!(byte & 0x80)) return value

            scale *= 0x80
            if (scale > Number.MAX_SAFE_INTEGER)
                throw new RangeError('Varint is too large')
        }
    }

    bytes() {
        return this.raw(this.varint())
    }

    string() {
        return decodeUtf8(this.bytes())
    }

    private require(count: number) {
        if (this.cursor + count > this.buffer.length)
            throw new RangeError(
                `Frame ended after ${this.buffer.length} bytes, needed ${this.cursor + count}`,
            )
    }
}

export function encodeUtf8(value: string) {
    const utf8: number[] = []

    for (let i = 0; i < value.length; i++) {
        let point = value.charCodeAt(i)

        if (point >= 0xd800 && point <= 0xdbff && i + 1 < value.length) {
            const low = value.charCodeAt(i + 1)
            if (low >= 0xdc00 && low <= 0xdfff) {
                point = (point - 0xd800) * 0x400 + low - 0xdc00 + 0x10000
                i++
            }
        }

        if (point < 0x80) utf8.push(point)
        else if (point < 0x800)
            utf8.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
        else if (point < 0x10000)
            utf8.push(
                0xe0 | (point >> 12),
                0x80 | ((point >> 6) & 0x3f),
                0x80 | (point & 0x3f),
            )
        else
            utf8.push(
                0xf0 | (point >> 18),
                0x80 | ((point >> 12) & 0x3f),
                0x80 | ((point >> 6) & 0x3f),
                0x80 | (point & 0x3f),
            )
    }

    return new Uint8Array(utf8)
}

export function decodeUtf8(bytes: Uint8Array) {
    let value = ''

    for (let i = 0; i < bytes.length; ) {
        const byte = bytes[i++]
        let point: number

        if (byte < 0x80) point = byte
        else if (byte < 0xe0) point = ((byte & 0x1f) << 6) | (bytes[i++] & 0x3f)
        else if (byte < 0xf0)
            point =
                ((byte & 0x0f) << 12) |
                ((bytes[i++] & 0x3f) << 6) |
                (bytes[i++] & 0x3f)
        else
            point =
                ((byte & 0x07) << 18) |
                ((bytes[i++] & 0x3f) << 12) |
                ((bytes[i++] & 0x3f) << 6) |
                (bytes[i++] & 0x3f)

        if (point > 0xffff) {
            point -= 0x10000
            value += String.fromCharCode(
                0xd800 + (point >> 10),
                0xdc00 + (point & 0x3ff),
            )
        } else value += String.fromCharCode(point)
    }

    return value
}
