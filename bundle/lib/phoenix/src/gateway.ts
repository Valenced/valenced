import type { GatewayListener } from './types'

const listen = (globalThis as any)[
    Symbol.for('valenced.phoenix.gateway.listen')
] as ((event: string, enabled: boolean) => boolean) | undefined

const sharedGlobal = globalThis as typeof globalThis & {
    __valencedPhoenixGatewayListeners?: Map<string, Set<GatewayListener<any>>>
}
const listeners = (sharedGlobal.__valencedPhoenixGatewayListeners ??= new Map())
const gateway = (globalThis.__valencedPhoenixGateway ??= {})

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
