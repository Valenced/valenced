import { callNativeMethod } from '@valenced/modules/native'
import { decodeUtf8, encodeUtf8 } from './bytes'
import { onDispatch, onInvoke } from './index'
import { joinDispatch } from './ui'
import type { GatewayListener, GatewaySendListener } from './types'

const SOCKET_MODULE = 0x3f
const SOCKET_SEND = 0x125
const SOCKET_MESSAGE = 0x17a
// IDENTIFY and RESUME carry the token
const PRIVATE_OPS = new Set([2, 6])

const listen = (globalThis as any)[
    Symbol.for('valenced.phoenix.gateway.listen')
] as ((event: string, enabled: boolean) => boolean) | undefined

const sharedGlobal = globalThis as typeof globalThis & {
    __valencedPhoenixGatewayListeners?: Map<string, Set<GatewayListener<any>>>
}
const listeners = (sharedGlobal.__valencedPhoenixGatewayListeners ??= new Map())
const gateway = (globalThis.__valencedPhoenixGateway ??= {})
const sendListeners = new Map<number, Set<GatewaySendListener<any>>>()
let offSend: (() => void) | undefined
let template: Uint8Array | undefined
let seq: number | null = null

onDispatch((_, bytes) => {
    if (bytes.length < 16 || bytes[0] !== 4 || bytes[1] !== 0) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    for (
        let at = 16 + view.getUint32(12, true);
        at + 4 <= bytes.length;
        at += 4 + view.getUint32(at, true)
    ) {
        const event = at + 4
        if (
            view.getUint32(at, true) < 16 ||
            view.getUint32(event, true) !== 3 ||
            view.getUint32(event + 4, true) !== SOCKET_MESSAGE
        )
            continue

        const body = event + 16 + view.getUint32(event + 12, true)
        template = bytes.slice(event, body)
        const s = /"s":(\d+)/.exec(decodeUtf8(bytes.subarray(body, body + 64)))
        if (s) seq = Number(s[1])
    }
})

/**
 * Listens to a gateway event, like `MESSAGE_CREATE`.
 *
 * The listener runs on Phoenix's store thread, before Phoenix sees the event. Returning a value
 * replaces the payload for Phoenix and for the listeners after it.
 *
 * @returns A function that removes the listener.
 */
export function on<T = any>(event: string, listener: GatewayListener<T>) {
    let set = listeners.get(event)
    if (!set) {
        listeners.set(event, (set = new Set()))
        gateway.onEvent = onEvent
        listen?.(event, true)
    }
    set.add(listener)

    return () => {
        set.delete(listener)
        if (set.size) return

        listeners.delete(event)
        listen?.(event, false)
        if (!listeners.size) gateway.onEvent = undefined
    }
}

/**
 * Feeds a gateway event to Phoenix as if the gateway sent it, with the last sequence number.
 * Listeners from {@link on} see it too. Only this client sees it.
 *
 * Resolves once the event is queued on Phoenix's guest thread.
 */
export async function dispatch(event: string, payload: unknown) {
    if (!template)
        throw new Error('Phoenix has not received a gateway message yet')

    const body = encodeUtf8(
        JSON.stringify({ t: event, s: seq, op: 0, d: payload }),
    )
    const message = new Uint8Array(template.length + body.length)
    message.set(template)
    message.set(body, template.length)

    const frame = joinDispatch([message])
    let binary = ''
    for (let i = 0; i < frame.length; i += 0x8000)
        binary += String.fromCharCode(...frame.subarray(i, i + 0x8000))
    const result = (await callNativeMethod('valenced.phoenix.dispatch', [
        btoa(binary),
    ])) as unknown as { error?: { message: string } } | null
    if (result?.error) throw new Error(result.error.message)
}

/**
 * Listens to gateway messages Phoenix sends, by opcode, like `3` for presence updates.
 *
 * The listener gets the message's `d` and runs on Phoenix's guest thread before the message
 * goes out. IDENTIFY and RESUME carry the token and are not available.
 *
 * @returns A function that removes the listener.
 */
export function onSend<T = any>(op: number, listener: GatewaySendListener<T>) {
    if (PRIVATE_OPS.has(op))
        throw new Error(`Gateway op ${op} is not available`)

    let set = sendListeners.get(op)
    if (!set) sendListeners.set(op, (set = new Set()))
    set.add(listener)
    offSend ??= onInvoke(bytes => {
        if (bytes.length < 16) return
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
        if (
            view.getUint16(2, true) !== SOCKET_MODULE ||
            view.getUint32(4, true) !== SOCKET_SEND
        )
            return

        const start = 16 + view.getUint32(12, true)
        const found = /"op":(\d+)/.exec(
            decodeUtf8(bytes.subarray(start, start + 16)),
        )
        const sending = sendListeners.get(Number(found?.[1]))
        if (!found || !sending?.size) return

        let message: { d?: unknown }
        try {
            message = JSON.parse(decodeUtf8(bytes.subarray(start)))
        } catch {
            nativeLoggingHook(
                `Unparsable gateway op ${found[1]}, sent as is`,
                2,
            )
            return
        }

        let replaced = false
        for (const send of sending) {
            const result = send(message.d)
            if (result === false) return false
            if (result !== undefined) {
                message.d = result
                replaced = true
            }
        }
        if (!replaced) return

        const body = encodeUtf8(JSON.stringify(message))
        const frame = new Uint8Array(start + body.length)
        frame.set(bytes.subarray(0, start))
        frame.set(body, start)
        return frame
    })

    return () => {
        set.delete(listener)
        if (set.size) return

        sendListeners.delete(op)
        if (sendListeners.size) return
        offSend?.()
        offSend = undefined
    }
}

function onEvent(event: string, data: string) {
    const set = listeners.get(event)
    if (!set?.size) return

    let payload: any
    try {
        payload = JSON.parse(data)
    } catch {
        nativeLoggingHook(`Unparsable ${event} payload, passed through`, 2)
        return
    }

    let replaced = false
    for (const listener of set) {
        const result = listener(payload)
        if (result === false) return false
        if (result !== undefined) {
            payload = result
            replaced = true
        }
    }

    return replaced ? JSON.stringify(payload) : undefined
}

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.phoenix.dispatch': [[frame: string], null]
    }
}
