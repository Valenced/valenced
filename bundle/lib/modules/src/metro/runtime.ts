/**
 * A minimal implementation of Metro's runtime with little overhead.
 * Making initialization faster and use less resources.
 *
 * Also avoids cloning exports, allowing for patches to be applied directly without checking for clones.
 */

import { callNativeMethodSync } from '@valenced/modules/native'
import { getErrorStack } from '@valenced/utils/error'
import { FullVersion } from '~constants'
import { loadModuleFromSegment, mList } from './patches'
import {
    executeInitializeSubscriptions,
    executeRequireSubscriptions,
} from './subscriptions/_internal'
import type { Metro } from '../types'

export const mErrorChain: [Metro.ModuleID, unknown][] = []

export const Initialized = 1 << 0
export const HasError = 1 << 1
export const HasImportedAll = 1 << 2
export const Initializing = 1 << 3

const InitializedOrInitializing = Initialized | Initializing
const NotInitializedOrInitializingMask = ~InitializedOrInitializing

export const global = globalThis

export const metroRequire = (moduleId => {
    let mod = mList.get(moduleId)

    // Module isn't registered yet, maybe it's in another segment that hasn't been loaded yet.
    if (!mod) mod = loadModuleFromSegment(moduleId)
    if (!mod) throw new Error(`Requiring unknown module: ${moduleId}`)

    let { flags, module: moduleObject } = mod

    if (flags & InitializedOrInitializing) return moduleObject!.exports
    if (flags & HasError) {
        // Swallow the error and return an empty object, like what Metro does.
        // throw mod.error
        return moduleObject!.exports
    }

    mod.flags |= Initializing

    moduleObject = mod.module = {
        exports: {},
        id: moduleId,
    }

    executeRequireSubscriptions(moduleId)

    try {
        const { factory } = mod
        mod.factory = undefined

        factory!()
    } catch (e) {
        // Keep flags set while the factory ran
        mod.flags = (mod.flags & NotInitializedOrInitializingMask) | HasError
        mod.error = e

        const msg = `Module ${moduleId} failed to initialize:\n\n${getErrorStack(e)}`

        if (__DEV__) {
            callNativeMethodSync('valenced.alertError', [msg, FullVersion])
        } else {
            nativeLoggingHook(msg, 2)
        }

        // Some modifications can cause modules to fail by initializing them in the wrong order, we can't just blacklist them
        // cacheBlacklistedModule(moduleId)

        // So... it wasn't a great idea to throw, Discord has pushed a broken build that has some failing modules
        // Vanilla Metro would swallow the error and just return an empty object as the exports..., insanity

        // // @ts-expect-error: Not documented, but used by React Native
        // if (global.ErrorUtils) global.ErrorUtils.reportFatalError(e)
        // else throw e

        mErrorChain.push([moduleId, e])

        // Namespace from a cycle keeps the values read so far, like the exports did before
        const { exports } = moduleObject
        if (mod.flags & HasImportedAll && mod.importedAll !== exports)
            pinKeys(mod.importedAll, exports)

        return (moduleObject.exports = {})
    }

    mod.flags = (mod.flags & NotInitializedOrInitializingMask) | Initialized

    // Namespace from a cycle only has the keys that existed then
    if (mod.flags & HasImportedAll && mod.importedAll !== moduleObject.exports)
        defineLiveKeys(mod.importedAll, moduleObject)

    executeInitializeSubscriptions(moduleId, moduleObject.exports)

    return moduleObject.exports
}) as Metro.Require

global.__r = metroRequire

// Uncached, so late patches on default reach callers reading at each use
export const metroImportDefault: Metro.RequireFn = moduleId => {
    const exports = metroRequire(moduleId)
    return exports?.__esModule ? exports.default : exports
}

export const metroImportAll: Metro.RequireFn = moduleId => {
    const exports = metroRequire(moduleId)

    const mod = mList.get(moduleId)!
    if (mod.flags & HasImportedAll) return mod.importedAll

    mod.flags |= HasImportedAll

    if (exports?.__esModule) return (mod.importedAll = exports)

    // Copy like Metro, but with live reads so patches on exports still reach the namespace
    const module = mod.module!
    const namespace = {}
    defineLiveKeys(namespace, module)
    liveProperty(namespace, 'default', () => module.exports)
    return (mod.importedAll = namespace)
}

const hasOwn = Object.prototype.hasOwnProperty
const { getOwnPropertyDescriptor } = Object

function defineLiveKeys(namespace: object, module: Metro.Module) {
    const { exports } = module
    for (const key in exports)
        if (
            hasOwn.call(exports, key) &&
            key !== 'default' &&
            !hasOwn.call(namespace, key)
        )
            liveProperty(namespace, key, () => module.exports?.[key])
}

/** Replaces live keys with the values in `exports`, keeping keys written on the namespace. */
function pinKeys(namespace: object, exports: Metro.ModuleExports) {
    for (const key in exports)
        if (hasOwn.call(exports, key) && key !== 'default')
            if (
                !hasOwn.call(namespace, key) ||
                getOwnPropertyDescriptor(namespace, key)!.get
            )
                dataProperty(namespace, key, exports[key])

    if (getOwnPropertyDescriptor(namespace, 'default')!.get)
        dataProperty(namespace, 'default', exports)
}

function liveProperty(target: object, key: string, read: () => unknown) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get: read,
        // Metro namespaces are copies, so a write stays on the copy
        set: (value: unknown) => dataProperty(target, key, value),
    })
}

function dataProperty(target: object, key: string, value: unknown) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
}
