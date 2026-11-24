/**
 * Return `undefined` to pass the frame through, `false` to drop it, or bytes to
 * replace the payload. A replacement is passed on to the remaining listeners.
 */
export type OpsListener = (
    bytes: Uint8Array,
) => Uint8Array | false | undefined | void

/** Same drop and replace semantics as {@link OpsListener}. */
export type InvokeListener = (
    bytes: Uint8Array,
) => Uint8Array | false | undefined | void

/**
 * Return `undefined` to pass the frame through, bytes to replace it, or a boolean to skip the
 * host and return that instead. A replacement is passed on to the remaining listeners. The
 * first listener returning a boolean wins.
 */
export type DispatchListener = (
    handle: number,
    bytes: Uint8Array,
) => Uint8Array | boolean | undefined | void

/**
 * Return `undefined` to pass the event through, `false` to drop it, or a payload to replace it.
 * A replacement is passed on to the remaining listeners.
 */
export type GatewayListener<T = any> = (data: T) => T | false | undefined | void

/** Gateway handler the Phoenix host reads off `globalThis`. */
export interface PhoenixGateway {
    onEvent?: (event: string, data: string) => string | false | undefined
}

/** Frame handlers the Phoenix host reads off `globalThis`. */
export interface PhoenixFrames {
    onApplyOps?: (bytes: Uint8Array) => Uint8Array | false | undefined
    onInvoke?: (bytes: Uint8Array) => Uint8Array | false | undefined
    onDispatch?: (
        handle: number,
        bytes: Uint8Array,
    ) => Uint8Array | boolean | undefined
}

/** Lifecycle scope for a JavaScript plugin distributed through `dist.phoenix`. */
export interface PhoenixPluginScope {
    /** Register cleanup callbacks; they run in reverse order when the plugin stops. */
    cleanup(...callbacks: Array<() => unknown>): void
    /** Host logger, forwarded to Android logcat. */
    logger: {
        log(message: unknown): void
        warn(message: unknown): void
        error(message: unknown): void
    }
    /** The same frame and gateway API exported by `@valenced/phoenix`. */
    phoenix: typeof import('./index') & typeof import('./gateway')
    /** Synchronous native bridge for Phoenix host methods. */
    callNativeMethod(name: string, args?: unknown[]): unknown
    /** Persistent settings declared by this plugin's manifest. */
    settings: {
        get<T = unknown>(key: string): T
        set(key: string, value: string | number | boolean): Promise<void>
        subscribe(key: string, listener: (value: unknown) => void): () => void
    }
    /** Basic plugin identity and error reporting. */
    plugin: {
        id: string
        manifest: { id: string }
        reportError(error: unknown): void
    }
}

/** Options returned by a `dist.phoenix` plugin bundle. */
export interface PhoenixPluginOptions {
    start?(scope: PhoenixPluginScope): unknown
    stop?(scope: PhoenixPluginScope): unknown
}
