import type { DispatchListener, InvokeListener, OpsListener } from './types'

const frames = (globalThis.__valencedPhoenixFrames ??= {})

const phoenixBus = ((
    globalThis as typeof globalThis & {
        __valencedPhoenixBus?: {
            opsListeners: Set<OpsListener>
            invokeListeners: Set<InvokeListener>
            dispatchListeners: Set<DispatchListener>
        }
    }
).__valencedPhoenixBus ??= {
    opsListeners: new Set<OpsListener>(),
    invokeListeners: new Set<InvokeListener>(),
    dispatchListeners: new Set<DispatchListener>(),
})
const { opsListeners, invokeListeners, dispatchListeners } = phoenixBus

/**
 * Listens to UI op frames the guest sends to the host.
 *
 * @returns A function that removes the listener.
 */
export function onOps(listener: OpsListener) {
    opsListeners.add(listener)
    frames.onApplyOps = bytes => runFrameListeners(opsListeners, bytes)

    return () => {
        opsListeners.delete(listener)
        if (!opsListeners.size) frames.onApplyOps = undefined
    }
}

/**
 * Listens to invoke frames the guest sends to the host.
 *
 * @returns A function that removes the listener.
 */
export function onInvoke(listener: InvokeListener) {
    invokeListeners.add(listener)
    frames.onInvoke = bytes => runFrameListeners(invokeListeners, bytes)

    return () => {
        invokeListeners.delete(listener)
        if (!invokeListeners.size) frames.onInvoke = undefined
    }
}

/**
 * Listens to dispatch frames the host sends to the guest.
 *
 * @returns A function that removes the listener.
 */
export function onDispatch(listener: DispatchListener) {
    dispatchListeners.add(listener)
    frames.onDispatch = dispatchFrame

    return () => {
        dispatchListeners.delete(listener)
        if (!dispatchListeners.size) frames.onDispatch = undefined
    }
}

function runFrameListeners(
    listeners: Set<OpsListener | InvokeListener>,
    bytes: Uint8Array,
) {
    let payload: Uint8Array | undefined

    for (const listener of listeners) {
        const result = listener(payload ?? bytes)
        if (result === false) return false
        if (result) payload = result
    }

    return payload
}

function dispatchFrame(handle: number, bytes: Uint8Array) {
    let payload: Uint8Array | undefined

    for (const listener of dispatchListeners) {
        const result = listener(handle, payload ?? bytes)
        if (typeof result === 'boolean') return result
        if (result) payload = result
    }

    return payload
}
