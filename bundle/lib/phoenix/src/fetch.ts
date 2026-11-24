import { callNativeMethod } from '@valenced/modules/native'
import { decodeUtf8, encodeUtf8 } from './bytes'

type AbortListener = (event: { type: 'abort'; target: AbortSignal }) => unknown

class AbortSignal {
    aborted = false
    reason: unknown
    onabort: AbortListener | null = null
    listeners = new Set<AbortListener>()

    addEventListener(type: string, listener: AbortListener) {
        if (type === 'abort') this.listeners.add(listener)
    }

    removeEventListener(type: string, listener: AbortListener) {
        if (type === 'abort') this.listeners.delete(listener)
    }

    throwIfAborted() {
        if (this.aborted) throw this.reason
    }
}

export class AbortController {
    readonly signal = new AbortSignal()

    abort(
        reason: unknown = Object.assign(
            new Error('This operation was aborted'),
            { name: 'AbortError' },
        ),
    ) {
        const { signal } = this
        if (signal.aborted) return

        signal.aborted = true
        signal.reason = reason
        const event = { type: 'abort' as const, target: signal }
        signal.onabort?.(event)
        for (const listener of signal.listeners) listener(event)
    }
}

export class FormData {
    parts: Array<[name: string, value: unknown, filename?: string]> = []

    append(name: string, value: unknown, filename?: string) {
        this.parts.push([name, value, filename])
    }

    set(name: string, value: unknown, filename?: string) {
        this.delete(name)
        this.append(name, value, filename)
    }

    delete(name: string) {
        this.parts = this.parts.filter(([key]) => key !== name)
    }

    get(name: string) {
        return this.parts.find(([key]) => key === name)?.[1] ?? null
    }

    getAll(name: string) {
        return this.parts
            .filter(([key]) => key === name)
            .map(([, value]) => value)
    }

    has(name: string) {
        return this.parts.some(([key]) => key === name)
    }

    forEach(callback: (value: unknown, name: string, form: FormData) => void) {
        for (const [name, value] of this.parts) callback(value, name, this)
    }

    *entries() {
        for (const [name, value] of this.parts)
            yield [name, value] as [string, unknown]
    }

    [Symbol.iterator]() {
        return this.entries()
    }
}

class Headers {
    map = new Map<string, string>()

    constructor(init?: unknown) {
        const entries =
            init instanceof Headers
                ? init.map
                : Array.isArray(init)
                  ? init
                  : Object.entries(init ?? {})
        for (const [name, value] of entries) this.append(name, value)
    }

    append(name: string, value: string) {
        const old = this.map.get(name.toLowerCase())
        this.map.set(
            name.toLowerCase(),
            old === undefined ? String(value) : `${old}, ${value}`,
        )
    }

    set(name: string, value: string) {
        this.map.set(name.toLowerCase(), String(value))
    }

    get(name: string) {
        return this.map.get(name.toLowerCase()) ?? null
    }

    has(name: string) {
        return this.map.has(name.toLowerCase())
    }

    delete(name: string) {
        this.map.delete(name.toLowerCase())
    }

    forEach(callback: (value: string, name: string, headers: Headers) => void) {
        for (const [name, value] of this.map) callback(value, name, this)
    }

    entries() {
        return this.map.entries()
    }

    [Symbol.iterator]() {
        return this.map.entries()
    }
}

class Response {
    readonly type = 'basic'
    readonly ok: boolean
    bodyUsed = false

    constructor(
        readonly body: Uint8Array,
        readonly status: number,
        readonly statusText: string,
        readonly headers: Headers,
        readonly url: string,
        readonly redirected: boolean,
    ) {
        this.ok = status >= 200 && status < 300
    }

    async arrayBuffer() {
        this.bodyUsed = true
        return this.body.slice().buffer
    }

    async text() {
        this.bodyUsed = true
        return decodeUtf8(this.body)
    }

    async json() {
        return JSON.parse(await this.text())
    }
}

function toBytes(value: unknown) {
    if (typeof value === 'string') return encodeUtf8(value)
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError(
        'Phoenix fetch bodies must be strings, buffers or FormData',
    )
}

export async function fetch(
    input: string | { url: string },
    init: {
        method?: string
        headers?: unknown
        body?: unknown
        signal?: AbortSignal
    } = {},
) {
    const { signal, body: source } = init
    signal?.throwIfAborted()

    const headers = new Headers(init.headers)
    let body: Uint8Array | undefined
    if (source instanceof FormData) {
        const boundary = `ValencedFormBoundary${Math.random().toString(16).slice(2)}`
        const parts = source.parts.flatMap(([name, value, filename]) => [
            encodeUtf8(
                typeof value === 'string'
                    ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`
                    : `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename ?? 'blob'}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            ),
            toBytes(value),
            encodeUtf8('\r\n'),
        ])
        parts.push(encodeUtf8(`--${boundary}--\r\n`))

        body = new Uint8Array(
            parts.reduce((size, part) => size + part.length, 0),
        )
        let offset = 0
        for (const part of parts) {
            body.set(part, offset)
            offset += part.length
        }
        headers.set('content-type', `multipart/form-data; boundary=${boundary}`)
    } else if (source != null) {
        body = toBytes(source)
        if (typeof source === 'string' && !headers.has('content-type'))
            headers.set('content-type', 'text/plain;charset=UTF-8')
    }

    let encoded: string | undefined
    if (body) {
        encoded = ''
        for (let i = 0; i < body.length; i += 0x8000)
            encoded += String.fromCharCode(...body.subarray(i, i + 0x8000))
        encoded = btoa(encoded)
    }

    const request = callNativeMethod(
        'valenced.http.fetch' as never,
        [
            typeof input === 'string' ? input : input.url,
            (init.method ?? 'GET').toUpperCase(),
            [...headers],
            encoded,
        ] as never,
    ) as unknown as Promise<{
        status: number
        statusText: string
        url: string
        redirected: boolean
        headers: [string, string][]
        body: string
    }>

    const response = await (signal
        ? Promise.race([
              request,
              new Promise<never>((_, reject) =>
                  signal.addEventListener('abort', () => reject(signal.reason)),
              ),
          ])
        : request)

    return new Response(
        Uint8Array.from(atob(response.body), char => char.charCodeAt(0)),
        response.status,
        response.statusText,
        new Headers(response.headers),
        response.url,
        response.redirected,
    )
}
