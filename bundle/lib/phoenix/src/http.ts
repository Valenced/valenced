import { callNativeMethod } from '@valenced/modules/native'
import { ByteReader, ByteWriter, decodeUtf8, encodeUtf8 } from './bytes'
import { onDispatch, onInvoke } from './index'

const HTTP_MODULE = 0x2b
const HTTP_FETCH = 0xa8
const HTTP_RESPONSE = 0x141
const ID = 161
const METHOD = 165
const URL_FIELD = 166
const HEADERS = 167
const EXPOSED = 168
const STATUS = 174
const DISCORD_API = /^https:\/\/(\w+\.)?discord\.com\/api\//
const REQUEST_HEADERS = new Set(['content-type', 'x-context-properties'])
const EXPOSED_HEADERS = ['Retry-After', 'ETag', 'Content-Type']

/** A Discord API request Phoenix sends through `GuestHost.invoke`. */
export interface HttpRequest {
    id: number
    method: string
    url: string
    body: Uint8Array
}

export interface HttpResponse {
    status: number
    headers: Record<string, string>
    body: Uint8Array
}

/**
 * Return `undefined` to pass the request through, `false` to drop it, or a request to replace it.
 * A dropped request needs a reply through {@link respond} or {@link resend}, or Phoenix waits on it.
 */
export type HttpListener = (
    request: HttpRequest,
) => HttpRequest | false | undefined | void

interface Frame extends HttpRequest {
    seq: number
    /** Encoded fields other than id, method and url, in order. */
    rest: Uint8Array[]
}

const listeners = new Set<HttpListener>()
const watchers = new Map<number, (response: HttpResponse) => void>()
const pending = new Map<
    number,
    [(response: HttpResponse) => void, (error: unknown) => void]
>()
const frames = new Map<number, Frame>()
const replies: Uint8Array[] = []
const waiting: Array<() => void> = []
let attached = false
let nextId = 0x60000000
let lastSeq = 0
// Raw header items from Phoenix's last authorized request. Copied into plugin requests, never decoded.
let headerItems: Uint8Array[] | undefined

/**
 * Listens to Discord API requests Phoenix sends.
 *
 * @returns A function that removes the listener.
 */
export function onRequest(listener: HttpListener) {
    attach()
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

/** Calls back once with the reply to a request Phoenix sent, without taking it from Phoenix. */
export function watch(id: number, callback: (response: HttpResponse) => void) {
    attach()
    watchers.set(id, callback)
}

/** Answers a dropped request in Phoenix's next dispatch batch. */
export function respond(
    id: number,
    status: number,
    body: Uint8Array | string = new Uint8Array(),
    headers: Record<string, string> = {},
) {
    attach()
    const entries = Object.entries(headers)
    const struct = new ByteWriter()
        .u8(8)
        .i32(3)
        .varint(ID)
        .u8(3)
        .i32(id)
        .varint(STATUS)
        .u8(3)
        .i32(status)
        .varint(HEADERS)
        .u8(10)
        .i32(entries.length)
    for (const [name, value] of entries) {
        const key = encodeUtf8(name)
        const text = encodeUtf8(value)
        struct.i32(key.length).raw(key).u8(6).i32(text.length).raw(text)
    }
    const bytes = struct.toBytes()
    replies.push(
        new ByteWriter()
            .u32(3)
            .u32(HTTP_RESPONSE)
            .u32(0)
            .u32(bytes.length)
            .raw(bytes)
            .raw(typeof body === 'string' ? encodeUtf8(body) : body)
            .toBytes(),
    )
}

/** Sends a dropped Phoenix request again, so Phoenix gets the reply under its own id. */
export function resend(request: HttpRequest) {
    const frame = frames.get(request.id)
    if (!frame) throw new Error(`Unknown Phoenix request ${request.id}`)
    frames.delete(request.id)
    return invoke(encodeFrame({ ...frame, ...request }))
}

/**
 * Sends a Discord API request through Phoenix's HTTP path, with the headers Phoenix sends.
 * Valenced copies those headers without reading them.
 */
export async function request({
    method = 'GET',
    url,
    headers = {},
    body,
}: {
    method?: string
    url: string
    headers?: Record<string, string>
    body?: Uint8Array | string
}): Promise<HttpResponse> {
    if (!DISCORD_API.test(url))
        throw new Error(`Only Discord API URLs can be requested: ${url}`)

    attach()
    if (!headerItems)
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () =>
                    reject(
                        new Error('Phoenix sent no Discord request to copy'),
                    ),
                60_000,
            )
            waiting.push(() => {
                clearTimeout(timeout)
                resolve()
            })
        })

    const id = nextId++
    const extra = Object.entries(headers).filter(
        ([name]) => name.toLowerCase() !== 'authorization',
    )
    const items = new ByteWriter().u8(7).i32(headerItems!.length + extra.length)
    for (const item of headerItems!) items.raw(item)
    for (const pair of extra) writeStrings(items, pair)

    const exposed = writeStrings(new ByteWriter(), EXPOSED_HEADERS)

    const frame = encodeFrame({
        id,
        seq: lastSeq,
        method: method.toUpperCase(),
        url,
        body:
            typeof body === 'string'
                ? encodeUtf8(body)
                : (body ?? new Uint8Array()),
        rest: [
            field(HEADERS, items.toBytes()),
            field(EXPOSED, exposed.toBytes()),
        ],
    })

    const response = new Promise<HttpResponse>((resolve, reject) =>
        pending.set(id, [resolve, reject]),
    )
    const timeout = setTimeout(() => {
        pending.get(id)?.[1](new Error(`No reply to ${method} ${url}`))
        pending.delete(id)
    }, 60_000)
    try {
        await invoke(frame)
        return await response
    } catch (error) {
        pending.delete(id)
        throw error
    } finally {
        clearTimeout(timeout)
    }
}

async function invoke(frame: Uint8Array) {
    let binary = ''
    for (let i = 0; i < frame.length; i += 0x8000)
        binary += String.fromCharCode(...frame.subarray(i, i + 0x8000))
    const result = (await callNativeMethod('valenced.phoenix.http.invoke', [
        btoa(binary),
    ])) as unknown as { error?: { message: string } } | null
    if (result?.error) throw new Error(result.error.message)
}

function attach() {
    if (attached) return
    attached = true

    onInvoke(bytes => {
        const frame = decodeFrame(bytes)
        if (!frame) return
        lastSeq = frame.seq

        if (DISCORD_API.test(frame.url)) {
            const items = authorizedHeaders(frame)
            if (items) {
                headerItems = items
                for (const resolve of waiting.splice(0)) resolve()
            }
        }

        let request: HttpRequest = frame
        for (const listener of listeners) {
            const result = listener(request)
            if (result === false) {
                frames.set(frame.id, frame)
                return false
            }
            if (result) request = result
        }
        if (request !== frame) return encodeFrame({ ...frame, ...request })
    })

    onDispatch((_, bytes) => {
        if (!pending.size && !watchers.size && !replies.length) return
        if (bytes.length < 16) return
        const reader = new ByteReader(bytes)
        if (reader.u16() !== 4) return

        reader.raw(10)
        const header = bytes.subarray(0, 16 + reader.u32())
        reader.raw(header.length - 16)

        const events: Uint8Array[] = []
        let cut = false
        while (reader.remaining) {
            const event = reader.raw(reader.u32())
            const response = decodeResponse(event)
            const callbacks = response && pending.get(response[0])
            if (callbacks) {
                pending.delete(response[0])
                callbacks[0](response[1])
                cut = true
                continue
            }
            if (response && watchers.has(response[0])) {
                watchers.get(response[0])!(response[1])
                watchers.delete(response[0])
            }
            events.push(event)
        }

        if (!cut && !replies.length) return
        events.push(...replies.splice(0))
        const writer = new ByteWriter().raw(header)
        for (const event of events) writer.u32(event.length).raw(event)
        return writer.toBytes()
    })
}

function decodeFrame(bytes: Uint8Array): Frame | undefined {
    if (bytes.length < 16) return
    const reader = new ByteReader(bytes)
    if (reader.u16() !== 1 || reader.u16() !== HTTP_MODULE) return
    if (reader.u32() !== HTTP_FETCH) return
    const seq = reader.u32()
    const length = reader.u32()
    if (reader.u8() !== 8) return

    const frame: Frame = {
        id: 0,
        seq,
        method: '',
        url: '',
        body: bytes.subarray(16 + length),
        rest: [],
    }
    for (let count = reader.i32(); count > 0; count--) {
        const start = reader.offset
        const key = reader.varint()
        const tag = reader.u8()
        if (key === ID && tag === 3) frame.id = reader.i32()
        else if (key === METHOD && tag === 6)
            frame.method = decodeUtf8(reader.raw(reader.i32()))
        else if (key === URL_FIELD && tag === 6)
            frame.url = decodeUtf8(reader.raw(reader.i32()))
        else {
            skipValue(reader, tag)
            frame.rest.push(bytes.subarray(start, reader.offset))
        }
    }
    return frame.url ? frame : undefined
}

function encodeFrame(frame: Frame) {
    const struct = new ByteWriter()
        .u8(8)
        .i32(3 + frame.rest.length)
        .varint(ID)
        .u8(3)
        .i32(frame.id)
    writeStrings(struct.varint(METHOD), [frame.method], false)
    writeStrings(struct.varint(URL_FIELD), [frame.url], false)
    for (const field of frame.rest) struct.raw(field)

    const bytes = struct.toBytes()
    return new ByteWriter()
        .u16(1)
        .u16(HTTP_MODULE)
        .u32(HTTP_FETCH)
        .u32(frame.seq)
        .u32(bytes.length)
        .raw(bytes)
        .raw(frame.body)
        .toBytes()
}

function decodeResponse(event: Uint8Array): [number, HttpResponse] | undefined {
    if (event.length < 16) return
    const reader = new ByteReader(event)
    if (reader.u32() !== 3 || reader.u32() !== HTTP_RESPONSE) return
    reader.u32()
    const length = reader.u32()
    if (reader.u8() !== 8) return

    let id: number | undefined
    const response: HttpResponse = {
        status: 0,
        headers: {},
        body: event.subarray(16 + length),
    }
    for (let count = reader.i32(); count > 0; count--) {
        const key = reader.varint()
        const tag = reader.u8()
        if (key === ID && tag === 3) id = reader.i32()
        else if (key === STATUS && tag === 3) response.status = reader.i32()
        else if (key === HEADERS && tag === 10)
            for (let entries = reader.i32(); entries > 0; entries--) {
                const name = decodeUtf8(reader.raw(reader.i32()))
                const valueTag = reader.u8()
                if (valueTag === 6)
                    response.headers[name.toLowerCase()] = decodeUtf8(
                        reader.raw(reader.i32()),
                    )
                else skipValue(reader, valueTag)
            }
        else skipValue(reader, tag)
    }
    return id === undefined ? undefined : [id, response]
}

/** Header items of a request carrying `authorization`, minus per-request ones. Reads names only. */
function authorizedHeaders(frame: Frame) {
    for (const field of frame.rest) {
        const reader = new ByteReader(field)
        if (reader.varint() !== HEADERS || reader.u8() !== 7) continue

        const items: Uint8Array[] = []
        let authorized = false
        for (let count = reader.i32(); count > 0; count--) {
            const start = reader.offset
            if (reader.u8() !== 7 || reader.i32() !== 2 || reader.u8() !== 6)
                return
            const name = decodeUtf8(reader.raw(reader.i32())).toLowerCase()
            skipValue(reader, reader.u8())
            if (name === 'authorization') authorized = true
            if (!REQUEST_HEADERS.has(name))
                items.push(field.subarray(start, reader.offset))
        }
        return authorized ? items : undefined
    }
}

function field(key: number, value: Uint8Array) {
    return new ByteWriter().varint(key).raw(value).toBytes()
}

function writeStrings(writer: ByteWriter, strings: string[], array = true) {
    if (array) writer.u8(7).i32(strings.length)
    for (const string of strings) {
        const utf8 = encodeUtf8(string)
        writer.u8(6).i32(utf8.length).raw(utf8)
    }
    return writer
}

function skipValue(reader: ByteReader, tag: number) {
    switch (tag) {
        case 3:
            reader.raw(4)
            break
        case 4:
        case 5:
            reader.raw(8)
            break
        case 6:
            reader.raw(reader.i32())
            break
        case 7:
            for (let count = reader.i32(); count > 0; count--)
                skipValue(reader, reader.u8())
            break
        case 8:
            for (let count = reader.i32(); count > 0; count--) {
                reader.varint()
                skipValue(reader, reader.u8())
            }
            break
        case 9:
            reader.raw(16)
            break
        case 10:
            for (let count = reader.i32(); count > 0; count--) {
                reader.raw(reader.i32())
                skipValue(reader, reader.u8())
            }
            break
        default:
            if (tag > 2) throw new Error(`Unknown HTTP value tag ${tag}`)
    }
}

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.phoenix.http.invoke': [[frame: string], null]
    }
}
