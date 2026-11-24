import { onDispatch, onOps } from './index'
import {
    decodeOps,
    decodeViewEvent,
    encodeOps,
    joinDispatch,
    propKey,
    propName,
    splitDispatch,
} from './ui'
import type { UiOp, UiProp, UiValue, UiViewEvent } from './ui'

/** Node of Discord's tree as the guest sent it, without inserted nodes. */
export interface ViewNode {
    readonly id: number
    readonly type: string
    readonly props: readonly UiProp[]
    readonly children: readonly number[]
    readonly parent?: number
}

export interface ViewQuery {
    accessibilityId?: string | RegExp
    type?: string
    text?: string | RegExp
    where?: (node: ViewNode) => boolean
}

/**
 * A {@link UiValue} or a plain value. A number takes the type of the value it replaces, else
 * `f64`. `null` removes the prop.
 */
export type ViewPropValue =
    | UiValue
    | string
    | number
    | boolean
    | string[]
    | null

/** Return `false` to keep the event from Discord. */
export type ViewEventHandler = (
    event: UiViewEvent,
) => boolean | undefined | void

export interface ViewSpec {
    /** Node to copy type and props from. Its later updates reach the copy, except props set here. */
    from?: number
    type?: string
    props?: Record<string, ViewPropValue>
    children?: ViewSpec[]
    on?: Record<string, ViewEventHandler>
    /** Name for the node's id in {@link ViewPatch.keys}. */
    key?: string
}

export type InsertAt = 'before' | 'after' | 'start' | 'end'

export interface ViewPatch {
    /** Root node id, `-1` if the insert failed. */
    id: number
    keys: Record<string, number>
    /** Set once removed, or once the anchor was deleted. */
    removed: boolean
    remove(): void
}

interface Node {
    id: number
    type: string
    props: UiProp[]
    children: number[]
    parent?: number
}

interface OwnNode extends Node {
    from?: number
    keys: number[]
}

interface Insert {
    anchor: number
    at: InsertAt
    root: number
}

interface Rec {
    target: number
    owner: Set<Rec>
    undo(): void
    drop(): number[] | void
}

interface Watcher {
    query: ViewQuery
    callback: (node: ViewNode) => (() => void) | undefined | void
    matched: Map<number, (() => void) | undefined | void>
}

const guest = new Map<number, Node>()
const own = new Map<number, OwnNode>()
const inserts = new Map<number, Insert[]>()
const roots = new Map<number, Insert>()
const hidden = new Map<number, number>()
const layers = new Map<number, UiProp[][]>()
const listeners = new Map<number, Map<string, Set<ViewEventHandler>>>()
const clones = new Map<number, Set<number>>()
const observers = new Map<number, Set<(node: ViewNode) => void>>()
const watchers = new Set<Watcher>()
const targets = new Map<number, Set<Rec>>()
const patched = new Set<number>()

let out: UiOp[] | undefined
let dirty = false
let pending: UiOp[] = []
// Clear of the guest's own ids
let nextId = 0x50000000

const log = (message: string) => nativeLoggingHook(`[views] ${message}`, 2)

const get = (id: number) => guest.get(id) ?? own.get(id)

function emit(...ops: UiOp[]) {
    if (out) {
        out.push(...ops)
        dirty = true
    } else pending.push(...ops)
}

function track(
    owner: Set<Rec>,
    target: number,
    undo: () => void,
    drop: () => number[] | void,
) {
    const rec: Rec = { target, owner, undo, drop }
    owner.add(rec)
    let recs = targets.get(target)
    if (!recs) targets.set(target, (recs = new Set()))
    recs.add(rec)

    return () => {
        if (!owner.delete(rec)) return
        targets.get(target)?.delete(rec)
        rec.undo()
    }
}

function forget(id: number) {
    const ids: number[] = []
    for (const rec of [...(targets.get(id) ?? [])]) {
        rec.owner.delete(rec)
        ids.push(...(rec.drop() ?? []))
    }
    targets.delete(id)
    patched.delete(id)
    clones.delete(id)

    const node = own.get(id)
    if (node) {
        own.delete(id)
        if (node.from !== undefined) clones.get(node.from)?.delete(id)
        for (const child of node.children) ids.push(child, ...forget(child))
    } else {
        guest.delete(id)
        for (const watcher of watchers) {
            if (!watcher.matched.has(id)) continue
            const cleanup = watcher.matched.get(id)
            watcher.matched.delete(id)
            try {
                cleanup?.()
            } catch (e) {
                log(`Watch cleanup failed: ${e}`)
            }
        }
    }

    return ids
}

function matches(node: ViewNode, query: ViewQuery) {
    for (const [want, name] of [
        [query.accessibilityId, 'accessibilityId'],
        [query.text, 'text'],
    ] as const) {
        if (want === undefined) continue
        const value = prop(node, name)
        if (value?.type !== 'str') return false
        if (
            typeof want === 'string'
                ? want !== value.value
                : !want.test(value.value)
        )
            return false
    }
    if (query.type !== undefined && node.type !== query.type) return false
    return !query.where || query.where(node)
}

function current(id: number) {
    const node = get(id)!
    const values = new Map(node.props.map(it => [it.key, it.value]))
    for (const layer of layers.get(id) ?? [])
        for (const it of layer) values.set(it.key, it.value)

    const on = propKey('on')
    const events = listeners.get(id)
    if (on !== undefined && events?.size) {
        const value = values.get(on)
        const names = new Set(
            value?.type === 'arr'
                ? value.value.flatMap(it => (it.type === 'str' ? it.value : []))
                : [],
        )
        for (const name of events.keys()) names.add(name)
        values.set(on, {
            type: 'arr',
            value: [...names].map(name => ({ type: 'str', value: name })),
        })
    }

    return values
}

function pick(id: number, keys: number[]): UiOp {
    const values = current(id)
    return {
        op: 'update',
        id,
        props: keys.map(key => ({
            key,
            value: values.get(key) ?? { type: 'null' },
        })),
    }
}

function hostParent(id: number): number | undefined {
    const node = get(id)
    if (node?.parent !== undefined) return node.parent

    const insert = roots.get(id)
    if (!insert) return
    return insert.at === 'start' || insert.at === 'end'
        ? insert.anchor
        : hostParent(insert.anchor)
}

function sync(parent: number | undefined) {
    if (parent === undefined) return false

    const ids: number[] = []
    const add = (anchor: number, at: InsertAt) => {
        for (const it of inserts.get(anchor) ?? [])
            if (it.at === at && !hidden.has(it.root)) ids.push(it.root)
    }
    add(parent, 'start')
    for (const id of get(parent)?.children ?? []) {
        add(id, 'before')
        if (!hidden.has(id)) ids.push(id)
        add(id, 'after')
    }
    add(parent, 'end')

    const base = get(parent)?.children ?? []
    const same =
        ids.length === base.length && ids.every((id, at) => id === base[at])
    if (same && !patched.has(parent)) return false

    if (same) patched.delete(parent)
    else patched.add(parent)
    emit({ op: 'children', parent, ids })
    return true
}

function toValue(input: ViewPropValue, old: UiValue | undefined): UiValue {
    if (input === null) return { type: 'null' }
    if (typeof input === 'string') return { type: 'str', value: input }
    if (typeof input === 'boolean') return { type: 'bool', value: input }
    if (Array.isArray(input))
        return {
            type: 'arr',
            value: input.map(value => ({ type: 'str', value })),
        }
    if (typeof input !== 'number') return input
    if (old?.type === 'i32') return { type: 'i32', value: Math.round(input) }
    if (old?.type === 'i64')
        return { type: 'i64', value: BigInt(Math.round(input)) }
    return { type: 'f64', value: input }
}

function listen(
    owner: Set<Rec>,
    target: number,
    event: string,
    handler: ViewEventHandler,
) {
    let events = listeners.get(target)
    if (!events) listeners.set(target, (events = new Map()))
    let handlers = events.get(event)
    if (!handlers) events.set(event, (handlers = new Set()))
    handlers.add(handler)

    const remove = () => {
        handlers.delete(handler)
        if (!handlers.size) events.delete(event)
        if (!events.size) listeners.delete(target)
    }

    return track(
        owner,
        target,
        () => {
            remove()
            const on = propKey('on')
            if (on !== undefined) emit(pick(target, [on]))
        },
        remove,
    )
}

function build(
    owner: Set<Rec>,
    spec: ViewSpec,
    keys: Record<string, number>,
    made: number[],
    ops: UiOp[],
): number {
    const template = spec.from === undefined ? undefined : get(spec.from)
    if (spec.from !== undefined && !template)
        throw new Error(`No template node ${spec.from}`)
    const type = spec.type ?? template?.type
    if (!type) throw new Error('A view spec needs a type or a template')

    // Word lists are numbered by the host, so a copy would point at the wrong one
    const props = (template?.props ?? []).filter(
        it => it.value.type !== 'words' && it.value.type !== 'wpatch',
    )
    const overridden: number[] = []
    for (const [name, input] of Object.entries(spec.props ?? {})) {
        const key = propKey(name)
        if (key === undefined) {
            log(`Unknown prop ${name}`)
            continue
        }
        overridden.push(key)
        const at = props.findIndex(it => it.key === key)
        const value = toValue(input, props[at]?.value)
        if (at >= 0) props.splice(at, 1)
        if (value.type !== 'null') props.push({ key, value })
    }

    const id = nextId++
    const from = template && guest.has(template.id) ? template.id : undefined
    own.set(id, { id, type, props, children: [], from, keys: overridden })
    made.push(id)
    if (from !== undefined) {
        let ids = clones.get(from)
        if (!ids) clones.set(from, (ids = new Set()))
        ids.add(id)
    }
    if (spec.key) keys[spec.key] = id
    for (const [event, handler] of Object.entries(spec.on ?? {}))
        listen(owner, id, event, handler)

    ops.push({
        op: 'create',
        id,
        type,
        props: [...current(id)].map(([key, value]) => ({ key, value })),
    })

    const children = (spec.children ?? []).map(child =>
        build(owner, child, keys, made, ops),
    )
    for (const child of children) own.get(child)!.parent = id
    own.get(id)!.children = children
    if (children.length) ops.push({ op: 'children', parent: id, ids: children })

    return id
}

function check(watcher: Watcher, ids: Iterable<number>) {
    for (const id of ids) {
        const node = guest.get(id)
        let now = false
        try {
            now = !!node && matches(node, watcher.query)
        } catch (e) {
            log(`Watch query failed: ${e}`)
        }

        if (now && !watcher.matched.has(id)) {
            watcher.matched.set(id, undefined)
            try {
                watcher.matched.set(id, watcher.callback(node!))
            } catch (e) {
                log(`Watch callback failed: ${e}`)
            }
        } else if (!now && watcher.matched.has(id)) {
            const cleanup = watcher.matched.get(id)
            watcher.matched.delete(id)
            try {
                cleanup?.()
            } catch (e) {
                log(`Watch cleanup failed: ${e}`)
            }
        }
    }
}

/** Returns a node of Discord's tree or an inserted node. */
export function node(id: number): ViewNode | undefined {
    return get(id)
}

/** Returns the raw value of a prop. */
export function prop(target: number | ViewNode, name: string) {
    const key = propKey(name)
    const node = typeof target === 'number' ? get(target) : target
    return node?.props.find(it => it.key === key)?.value
}

/** Returns matching nodes of Discord's tree, in creation order, or depth first below `root`. */
export function findAll(query: ViewQuery, root?: number) {
    if (root === undefined)
        return [...guest.values()].filter(it => matches(it, query))

    const found: ViewNode[] = []
    const visit = (id: number) => {
        const node = get(id)
        if (!node) return
        if (id !== root && matches(node, query)) found.push(node)
        for (const child of node.children) visit(child)
    }
    visit(root)
    return found
}

/** Returns the first match of {@link findAll}. */
export function find(query: ViewQuery, root?: number): ViewNode | undefined {
    return findAll(query, root)[0]
}

/**
 * Creates a scope for UI changes. `dispose` undoes everything made through it.
 *
 * Changes made in `watch` and `observe` callbacks join the batch that ran them. Others wait for
 * Discord's next batch.
 */
export function createViews() {
    const owner = new Set<Rec>()

    const views = {
        node,
        prop,
        find,
        findAll,
        /**
         * Runs `callback` for each node that starts to match, after its batch. The returned
         * cleanup runs when the node stops matching or is deleted.
         */
        watch(
            query: ViewQuery,
            callback: (node: ViewNode) => (() => void) | undefined | void,
        ) {
            const watcher: Watcher = { query, callback, matched: new Map() }
            watchers.add(watcher)
            check(watcher, [...guest.keys()])

            return track(
                owner,
                -1,
                () => {
                    watchers.delete(watcher)
                    for (const cleanup of watcher.matched.values())
                        try {
                            cleanup?.()
                        } catch (e) {
                            log(`Watch cleanup failed: ${e}`)
                        }
                    watcher.matched.clear()
                },
                () => {},
            )
        },
        /** Runs `listener` after each batch that touched the node. */
        observe(target: number, listener: (node: ViewNode) => void) {
            let set = observers.get(target)
            if (!set) observers.set(target, (set = new Set()))
            set.add(listener)

            const remove = () => {
                set.delete(listener)
                if (!set.size) observers.delete(target)
            }
            return track(owner, target, remove, remove)
        },
        /** Inserts nodes next to or into `target`. They are deleted with it. */
        insert(target: number, at: InsertAt, spec: ViewSpec): ViewPatch {
            const patch: ViewPatch = {
                id: -1,
                keys: {},
                removed: true,
                remove() {},
            }
            if (!get(target)) {
                log(`No node ${target} to insert at`)
                return patch
            }

            const made: number[] = []
            const ops: UiOp[] = []
            try {
                patch.id = build(owner, spec, patch.keys, made, ops)
            } catch (e) {
                for (const id of made) forget(id)
                patch.id = -1
                log(`Insert failed: ${e}`)
                return patch
            }

            const entry: Insert = { anchor: target, at, root: patch.id }
            let list = inserts.get(target)
            if (!list) inserts.set(target, (list = []))
            list.push(entry)
            roots.set(patch.id, entry)
            patch.removed = false
            emit(...ops)
            sync(at === 'start' || at === 'end' ? target : hostParent(target))

            const unlink = () => {
                patch.removed = true
                list.splice(list.indexOf(entry), 1)
                if (!list.length) inserts.delete(target)
                roots.delete(patch.id)
            }
            patch.remove = track(
                owner,
                target,
                () => {
                    const parent = hostParent(patch.id)
                    unlink()
                    sync(parent)
                    emit({
                        op: 'delete',
                        ids: [patch.id, ...forget(patch.id)],
                    })
                },
                () => {
                    unlink()
                    return [patch.id, ...forget(patch.id)]
                },
            )
            return patch
        },
        /** Inserts nodes before `target` and hides it. */
        replace(target: number, spec: ViewSpec) {
            const patch = views.insert(target, 'before', spec)
            if (patch.removed) return patch

            const show = views.hide(target)
            const remove = patch.remove
            patch.remove = () => {
                show()
                remove()
            }
            return patch
        },
        /** Takes the node out of its parent on the host. */
        hide(target: number) {
            if (!get(target)) {
                log(`No node ${target} to hide`)
                return () => {}
            }

            const count = () => {
                const left = hidden.get(target)! - 1
                if (left) hidden.set(target, left)
                else hidden.delete(target)
            }
            hidden.set(target, (hidden.get(target) ?? 0) + 1)
            sync(hostParent(target))

            return track(
                owner,
                target,
                () => {
                    count()
                    sync(hostParent(target))
                },
                count,
            )
        },
        /** Overrides props until undone. On inserted nodes the change is permanent. */
        setProps(target: number, props: Record<string, ViewPropValue>) {
            if (!get(target)) {
                log(`No node ${target} to update`)
                return () => {}
            }

            const values = current(target)
            const layer: UiProp[] = []
            for (const [name, input] of Object.entries(props)) {
                const key = propKey(name)
                if (key === undefined) log(`Unknown prop ${name}`)
                else layer.push({ key, value: toValue(input, values.get(key)) })
            }
            const keys = layer.map(it => it.key)

            const ours = own.get(target)
            if (ours) {
                ours.props = [
                    ...ours.props.filter(it => !keys.includes(it.key)),
                    ...layer.filter(it => it.value.type !== 'null'),
                ]
                ours.keys.push(...keys)
                emit(pick(target, keys))
                return () => {}
            }

            let list = layers.get(target)
            if (!list) layers.set(target, (list = []))
            list.push(layer)
            emit(pick(target, keys))

            const remove = () => {
                list.splice(list.indexOf(layer), 1)
                if (!list.length) layers.delete(target)
            }
            return track(
                owner,
                target,
                () => {
                    remove()
                    emit(pick(target, keys))
                },
                remove,
            )
        },
        /** Listens to a view event by name, such as `press`. */
        on(target: number, event: string, handler: ViewEventHandler) {
            if (!get(target)) {
                log(`No node ${target} to listen on`)
                return () => {}
            }

            const key = propKey('on')
            const before =
                key === undefined ? undefined : current(target).get(key)
            const off = listen(owner, target, event, handler)
            if (
                key !== undefined &&
                JSON.stringify(current(target).get(key)) !==
                    JSON.stringify(before)
            )
                emit(pick(target, [key]))
            return off
        },
        dispose() {
            for (const rec of [...owner].reverse()) {
                if (!owner.delete(rec)) continue
                targets.get(rec.target)?.delete(rec)
                rec.undo()
            }
        },
    }

    return views
}

export type Views = ReturnType<typeof createViews>

onOps(bytes => {
    let ops: UiOp[]
    try {
        ops = decodeOps(bytes)
    } catch (e) {
        log(`Skipped a batch: ${e}`)
        return
    }

    out = pending
    pending = []
    dirty = out.length > 0
    const touched = new Set<number>()

    try {
        for (const op of ops) {
            switch (op.op) {
                case 'create': {
                    const node = guest.get(op.id)
                    if (node) {
                        node.type = op.type
                        node.props = op.props
                    } else
                        guest.set(op.id, {
                            id: op.id,
                            type: op.type,
                            props: op.props,
                            children: [],
                        })
                    touched.add(op.id)
                    out.push(op)
                    break
                }
                case 'update': {
                    const node = guest.get(op.id)
                    if (!node) {
                        out.push(op)
                        break
                    }

                    const keys = op.props.map(it => it.key)
                    node.props = [
                        ...node.props.filter(it => !keys.includes(it.key)),
                        ...op.props,
                    ]
                    touched.add(op.id)
                    if (layers.has(op.id) || listeners.has(op.id))
                        emit(pick(op.id, keys))
                    else out.push(op)

                    for (const id of clones.get(op.id) ?? []) {
                        const clone = own.get(id)!
                        const props = op.props.filter(
                            it =>
                                !clone.keys.includes(it.key) &&
                                it.value.type !== 'words' &&
                                it.value.type !== 'wpatch',
                        )
                        if (!props.length) continue
                        const changed = props.map(it => it.key)
                        clone.props = [
                            ...clone.props.filter(
                                it => !changed.includes(it.key),
                            ),
                            ...props.filter(it => it.value.type !== 'null'),
                        ]
                        emit(pick(id, changed))
                    }
                    break
                }
                case 'children':
                case 'childEdits': {
                    let parent = guest.get(op.parent)
                    if (!parent)
                        guest.set(
                            op.parent,
                            (parent = {
                                id: op.parent,
                                type: '',
                                props: [],
                                children: [],
                            }),
                        )

                    let ids = op.op === 'children' ? op.ids : []
                    if (op.op === 'childEdits') {
                        let cursor = 0
                        for (const edit of op.edits) {
                            ids.push(
                                ...parent.children.slice(
                                    cursor,
                                    cursor + edit.keep,
                                ),
                            )
                            cursor += edit.keep + edit.del
                            ids.push(...edit.ins)
                        }
                        ids = [...ids, ...parent.children.slice(cursor)]
                    }

                    for (const id of parent.children) {
                        const child = guest.get(id)
                        if (child?.parent === op.parent)
                            child.parent = undefined
                    }
                    parent.children = ids
                    for (const id of ids) {
                        const child = guest.get(id)
                        if (child) child.parent = op.parent
                    }
                    touched.add(op.parent)

                    if (!sync(op.parent)) out.push(op)
                    break
                }
                case 'delete': {
                    const ids = [...op.ids]
                    for (const id of op.ids)
                        if (guest.has(id)) ids.push(...forget(id))
                    if (ids.length === op.ids.length) out.push(op)
                    else emit({ op: 'delete', ids })
                    break
                }
                default:
                    out.push(op)
            }
        }

        for (const id of touched) {
            const node = guest.get(id)
            if (!node) continue
            for (const listener of [...(observers.get(id) ?? [])])
                try {
                    listener(node)
                } catch (e) {
                    log(`Observer failed: ${e}`)
                }
        }
        for (const watcher of [...watchers]) check(watcher, touched)

        return dirty ? encodeOps(out) : undefined
    } catch (e) {
        log(`Batch passed through unchanged: ${e}`)
    } finally {
        out = undefined
    }
})

onDispatch((_, bytes) => {
    if (!own.size && !listeners.size) return

    const frames = splitDispatch(bytes)
    const kept = frames.filter(frame => {
        const event = decodeViewEvent(frame)
        if (!event) return true

        const ours = own.has(event.node)
        const events = listeners.get(event.node)
        if (!ours && !events) return true

        const name = propName(event.event) ?? ''
        const subscribed = prop(event.node, 'on')
        let keep =
            !ours &&
            subscribed?.type === 'arr' &&
            subscribed.value.some(it => it.type === 'str' && it.value === name)

        for (const handler of [...(events?.get(name) ?? [])])
            try {
                if (handler(event) === false) keep = false
            } catch (e) {
                log(`Event handler failed: ${e}`)
            }
        return keep
    })

    if (kept.length !== frames.length) return joinDispatch(kept)
})
