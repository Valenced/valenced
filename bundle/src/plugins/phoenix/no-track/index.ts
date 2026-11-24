import { onDispatch, onInvoke } from '@valenced/phoenix'
import { ByteReader, ByteWriter, decodeUtf8 } from '@valenced/phoenix/bytes'
import { joinDispatch, splitDispatch } from '@valenced/phoenix/ui'

const HTTP_MODULE = 0x2b
const HTTP_FETCH = 0xa8
const HTTP_RESPONSE = 0x141
const SCIENCE = /^https:\/\/(\w+\.)?discord\.com\/api\/(v\d+\/)?science$/

const pending: number[] = []

function field(reader: ByteReader, key: number, type: number) {
    return reader.varint() === key && reader.u8() === type
}

// Request struct starts with id (161), method (165) and url (166)
function scienceRequestId(bytes: Uint8Array) {
    const reader = new ByteReader(bytes)
    if (reader.u16() !== 1 || reader.u16() !== HTTP_MODULE) return
    if (reader.u32() !== HTTP_FETCH) return
    reader.raw(8)
    if (reader.u8() !== 8 || reader.u32() < 3) return

    if (!field(reader, 161, 3)) return
    const id = reader.i32()
    if (!field(reader, 165, 6)) return
    reader.raw(reader.u32())
    if (!field(reader, 166, 6)) return
    if (SCIENCE.test(decodeUtf8(reader.raw(reader.u32())))) return id
}

onInvoke(bytes => {
    const id = scienceRequestId(bytes)
    if (id === undefined) return

    pending.push(id)
    return false
})

// Phoenix resends the whole event queue until a request answers, so each dropped one gets a 204
onDispatch((_, bytes) => {
    if (!pending.length || bytes[0] !== 4 || bytes[1] !== 0) return

    const frames = splitDispatch(bytes)
    for (const id of pending.splice(0)) {
        const body = new ByteWriter()
            .u8(8)
            .u32(3)
            .raw(new Uint8Array([0xa1, 0x01, 0x03]))
            .i32(id)
            .raw(new Uint8Array([0xae, 0x01, 0x03]))
            .u32(204)
            .raw(new Uint8Array([0xa7, 0x01, 0x0a]))
            .u32(0)
            .toBytes()

        frames.push(
            new ByteWriter()
                .u32(3)
                .u32(HTTP_RESPONSE)
                .u32(0)
                .u32(body.length)
                .raw(body)
                .toBytes(),
        )
    }
    return joinDispatch(frames)
})
