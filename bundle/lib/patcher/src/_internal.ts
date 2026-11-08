import type {
    AbstractNewable,
    AfterHook,
    BeforeHook,
    Callable,
    FiniteDomain,
    InsteadHook,
    UnknownFunction,
} from './types'

export interface FunctionProxyState<
    T extends UnknownFunction = UnknownFunction,
> {
    readonly proxy: T
    readonly target: T
}

export interface PatchedFunctionProxyState<
    Key extends PropertyKey = PropertyKey,
    Value extends UnknownFunction = UnknownFunction,
> extends FunctionProxyState<Value> {
    /** Must have a function valued property whose key is {@link key}. */
    readonly parent: Record<Key, Value>
    readonly key: Key
    before: HookNode<BeforeHook<Value>> | undefined
    instead: InsteadHookNode<Value> | undefined
    after: HookNode<AfterHook<Value>> | undefined
}

export interface HookNode<Hook extends UnknownFunction = UnknownFunction> {
    /** Checked so that hook node lists are not cleared if an unpatch function is called more than once. */
    unpatched: boolean
    /** Can be undefined only in instances that are not in a hook node list. */
    hook: Hook | undefined
    priority: number
    prev: HookNode<Hook> | undefined
    next: HookNode<Hook> | undefined
}

export interface InsteadHookNode<T extends UnknownFunction = UnknownFunction>
    extends HookNode<InsteadHook<T>>,
        FunctionProxyState<T> {
    hook: InsteadHook<T> | undefined
    priority: number
    prev: InsteadHookNode<T> | undefined
    next: InsteadHookNode<T> | undefined
}

/** @throws {TypeError} When `hookNode` is defined, its hook and that of all other hook nodes in its list must also be defined. */
function applyHooks<T>(hookNode: HookNode<(arg: T) => T> | undefined, arg: T) {
    while (hookNode) {
        // Save a reference to the next hook node in case the current hook calls unpatch.
        const { next, hook } = hookNode
        // Indirectly call the hook so as to not give it access to its hook node.
        arg = hook!(arg)
        hookNode = next
    }
    return arg
}

export const patchedFunctionProxyHandler = {
    apply<T extends Callable>(
        state: PatchedFunctionProxyState<PropertyKey, T>,
        receiver: ThisParameterType<T>,
        args: Parameters<T>,
    ) {
        args = applyHooks(state.before, args)

        const { instead } = state
        let result: ReturnType<T>

        if (instead === undefined)
            result = Reflect.apply(state.target, receiver, args)
        else
            result = Reflect.apply(
                // Call the instead hook directly, not through its proxy
                instead.hook!,
                receiver,
                [
                    args,
                    instead.next === undefined
                        ? state.target
                        : instead.next.proxy,
                ],
            )

        result = applyHooks(state.after, result)

        return result
    },
    construct<T extends AbstractNewable<never, object>>(
        state: PatchedFunctionProxyState<PropertyKey, T>,
        args: ConstructorParameters<T>,
        ctor: AbstractNewable,
    ) {
        args = applyHooks(state.before, args)

        const { instead } = state
        let result: InstanceType<T>

        if (instead === undefined)
            result = Reflect.construct(state.target, args, ctor)
        else
            result = Reflect.construct(
                // Call the instead hook directly, not through its proxy
                instead.hook!,
                [
                    args,
                    instead.next === undefined
                        ? state.target
                        : instead.next.proxy,
                ],
                ctor,
            )

        result = applyHooks(state.after, result)

        return result
    },
    defineProperty: (state, key, descriptor) =>
        Reflect.defineProperty(state.target, key, descriptor),
    deleteProperty: (state, key) => Reflect.deleteProperty(state.target, key),
    get: (state, key, receiver: unknown) =>
        Reflect.get(state.target, key, receiver),
    getOwnPropertyDescriptor: (state, key) =>
        Reflect.getOwnPropertyDescriptor(state.target, key),
    getPrototypeOf: state => Reflect.getPrototypeOf(state.target),
    has: (state, key) => Reflect.has(state.target, key),
    isExtensible: state => Reflect.isExtensible(state.target),
    ownKeys: state => Reflect.ownKeys(state.target),
    preventExtensions: state => Reflect.preventExtensions(state.target),
    set: (state, key, value: unknown, receiver: unknown) =>
        Reflect.set(state.target, key, value, receiver),
    setPrototypeOf: (state, prototype) =>
        Reflect.setPrototypeOf(state.target, prototype),
} as const satisfies Required<ProxyHandler<FunctionProxyState>>

interface PatchedFunctionProxyStateMap extends WeakMap<UnknownFunction, any> {
    readonly delete: (key: UnknownFunction) => boolean
    readonly get: <K extends UnknownFunction>(
        key: K,
    ) => PatchedFunctionProxyState<PropertyKey, K> | undefined
    readonly has: (key: UnknownFunction) => boolean
    readonly set: <K extends UnknownFunction>(
        key: K,
        value: PatchedFunctionProxyState<PropertyKey, K>,
    ) => this
}

/** proxy -> state */
export const patchedFunctionProxyStates: PatchedFunctionProxyStateMap =
    new WeakMap<UnknownFunction>()

/** Creates a proxy target matching the `prototype` slot of `target`, as proxy invariants require. */
export function createProxyTarget(target: UnknownFunction): any {
    const prototype =
        typeof target === 'function'
            ? Object.getOwnPropertyDescriptor(target, 'prototype')
            : undefined

    if (typeof target === 'function' && !prototype) {
        // Bound functions have no prototype, but stay constructible
        try {
            Reflect.construct(Object, [], target as never)
            // biome-ignore lint/complexity/useArrowFunction: We need a function that has a constructor
            return function () {}.bind(undefined)
        } catch {
            return () => {}
        }
    }

    // biome-ignore lint/complexity/useArrowFunction: We need a function that has a constructor
    const state = function () {}
    if (prototype) Object.defineProperty(state, 'prototype', prototype)
    return state
}

export function createPatchedFunctionProxy<
    Key extends PropertyKey,
    Value extends UnknownFunction,
>(
    target: Value,
    parent: Record<Key, Value>,
    key: FiniteDomain<Key>,
    before: HookNode<BeforeHook<Value>> | undefined,
    instead: InsteadHookNode<Value> | undefined,
    after: HookNode<AfterHook<Value>> | undefined,
): PatchedFunctionProxyState<Key, Value> {
    const state = createProxyTarget(target)
    // The handler makes the proxy behave as state.target.
    const proxy: Value = new Proxy(state, patchedFunctionProxyHandler) as any

    state.proxy = proxy
    state.target = target
    state.parent = parent
    state.key = key
    state.before = before
    state.instead = instead
    state.after = after

    patchedFunctionProxyStates.set(proxy, state)
    parent[key] = proxy

    return state
}

export function unproxy(state: PatchedFunctionProxyState) {
    const { parent, key, proxy } = state
    if (parent[key] === proxy) {
        parent[key] = state.target
        patchedFunctionProxyStates.delete(proxy)
    }
}
