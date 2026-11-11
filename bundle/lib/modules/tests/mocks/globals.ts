// Globals from Hermes, React Native and the build. Modules read some at import time.
export const logs: string[] = []

Object.assign(globalThis, {
    __DEV__: true,
    __METRO_GLOBAL_PREFIX__: '',
    __BUILD_FLAG_DEBUG_MODULE_LOOKUPS__: false,
    __BUILD_FLAG_DEBUG_MODULE_WAITS__: false,
    HermesInternal: { useEngineQueue: () => false },
    nativeLoggingHook: (message: string) => {
        logs.push(message)
    },
})
