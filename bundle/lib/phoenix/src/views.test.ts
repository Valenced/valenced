import { describe, expect, test } from 'vitest'
import {
    decodeOps,
    decodeViewEvent,
    encodeOps,
    encodeViewEvent,
    joinDispatch,
    splitDispatch,
} from './ui'
import { createViews, find, findAll, node, prop } from './views'
import type { UiOp, UiProp, UiValue } from './ui'
import type { ViewPatch } from './views'

const NAMES = [
    'on',
    'press',
    'accessibilityId',
    'text',
    'background',
    'color',
    'fontSize',
    'worklet',
    'longPress',
]
const logs: string[] = []

// @ts-expect-error
globalThis[Symbol.for('valenced.bridge.call.sync')] = () => ({ result: NAMES })
Object.assign(globalThis, {
    nativeLoggingHook: (message: string) => logs.push(message),
})

const frames = globalThis.__valencedPhoenixFrames!
const key = (name: string) => NAMES.indexOf(name)
const str = (value: string): UiValue => ({ type: 'str', value })
const prp = (name: string, value: UiValue): UiProp => ({
    key: key(name),
    value,
})
const ON_PRESS = prp('on', { type: 'arr', value: [str('press')] })
const FRAME: UiOp = { op: 'requestFrame' }

function apply(ops: UiOp[]) {
    const result = frames.onApplyOps!(encodeOps(ops))
    return result ? decodeOps(result) : undefined
}

function press(id: number, event = 'press') {
    const result = frames.onDispatch!(
        0,
        joinDispatch([
            encodeViewEvent({
                node: id,
                event: key(event),
                payload: { type: 'obj', value: [] },
            }),
        ]),
    )
    return result instanceof Uint8Array
        ? splitDispatch(result).map(frame => decodeViewEvent(frame)!.node)
        : result
}

// list > [search, section > [header, row]]
function screen(id: number): UiOp[] {
    return [
        {
            op: 'create',
            id,
            type: 'view',
            props: [prp('accessibilityId', str('list'))],
        },
        { op: 'create', id: id + 1, type: 'view', props: [] },
        { op: 'create', id: id + 2, type: 'view', props: [] },
        {
            op: 'create',
            id: id + 3,
            type: 'text',
            props: [
                prp('text', str('Account')),
                prp('color', { type: 'i64', value: 1n }),
            ],
        },
        {
            op: 'create',
            id: id + 4,
            type: 'view',
            props: [
                prp('accessibilityId', str('row')),
                prp('background', { type: 'i32', value: 5 }),
                ON_PRESS,
                prp('worklet', { type: 'words', value: [1, 2] }),
            ],
        },
        { op: 'children', parent: id + 2, ids: [id + 3, id + 4] },
        { op: 'children', parent: id, ids: [id + 1, id + 2] },
    ]
}

describe('tree', () => {
    test('follows the op stream and passes untouched batches through', () => {
        expect(apply(screen(100))).toBeUndefined()
        expect(find({ accessibilityId: 'list' })?.children).toEqual([101, 102])
        expect(node(104)?.parent).toBe(102)
        expect(find({ text: /^Acc/ })?.id).toBe(103)
        expect(findAll({ type: 'view' }, 102).map(it => it.id)).toEqual([104])
        expect(
            find({ where: it => it.type === 'text' && it.parent === 102 })?.id,
        ).toBe(103)

        expect(
            apply([
                {
                    op: 'childEdits',
                    parent: 100,
                    edits: [{ keep: 1, del: 1, ins: [] }],
                },
                { op: 'update', id: 103, props: [prp('text', str('Profile'))] },
            ]),
        ).toBeUndefined()
        expect(node(100)?.children).toEqual([101])
        expect(node(102)?.parent).toBeUndefined()
        expect(prop(103, 'text')).toEqual(str('Profile'))

        apply([{ op: 'delete', ids: [100, 101, 102, 103, 104] }])
        expect(node(100)).toBeUndefined()
    })
})

describe('insert', () => {
    test('joins the batch and survives Discord ops on the parent', () => {
        const views = createViews()
        const patches: ViewPatch[] = []
        views.watch({ accessibilityId: 'row' }, row => {
            patches.push(
                views.insert(row.parent!, 'before', {
                    from: row.parent,
                    key: 'section',
                    children: [
                        {
                            from: row.id,
                            key: 'row',
                            props: { background: 7, accessibilityId: 'mine' },
                        },
                    ],
                }),
            )
        })

        const out = apply(screen(200))!
        const [patch] = patches
        const { section, row } = patch.keys
        expect(out.slice(0, 7)).toEqual(screen(200))
        expect(out.slice(7)).toEqual([
            { op: 'create', id: section, type: 'view', props: [] },
            {
                op: 'create',
                id: row,
                type: 'view',
                props: [
                    ON_PRESS,
                    prp('background', { type: 'i32', value: 7 }),
                    prp('accessibilityId', str('mine')),
                ],
            },
            { op: 'children', parent: section, ids: [row] },
            { op: 'children', parent: 200, ids: [201, section, 202] },
        ])

        const extra: UiOp = { op: 'create', id: 205, type: 'view', props: [] }
        expect(
            apply([
                extra,
                {
                    op: 'childEdits',
                    parent: 200,
                    edits: [{ keep: 2, del: 0, ins: [205] }],
                },
            ]),
        ).toEqual([
            extra,
            { op: 'children', parent: 200, ids: [201, section, 202, 205] },
        ])
        expect(
            apply([{ op: 'children', parent: 200, ids: [202, 201] }]),
        ).toEqual([{ op: 'children', parent: 200, ids: [section, 202, 201] }])

        expect(apply([{ op: 'delete', ids: [202, 203, 204] }])).toEqual([
            { op: 'delete', ids: [202, 203, 204, section, row] },
        ])
        expect(patch.removed).toBe(true)
        expect(node(section)).toBeUndefined()

        const again = apply([
            { op: 'create', id: 206, type: 'view', props: [] },
            {
                op: 'create',
                id: 207,
                type: 'view',
                props: [prp('accessibilityId', str('row'))],
            },
            { op: 'children', parent: 206, ids: [207] },
            { op: 'children', parent: 200, ids: [201, 206] },
        ])!
        expect(patches).toHaveLength(2)
        expect(again.at(-1)).toEqual({
            op: 'children',
            parent: 200,
            ids: [201, patches[1].id, 206],
        })

        views.dispose()
        expect(apply([FRAME])).toEqual([
            { op: 'children', parent: 200, ids: [201, 206] },
            { op: 'delete', ids: [patches[1].id, patches[1].keys.row] },
            FRAME,
        ])
    })

    test('hides, replaces and appends on the next batch', () => {
        apply(screen(300))
        const views = createViews()

        const show = views.hide(301)
        const end = views.insert(300, 'end', {
            type: 'text',
            props: { text: 'End' },
        })
        expect(apply([FRAME])).toEqual([
            { op: 'children', parent: 300, ids: [302] },
            {
                op: 'create',
                id: end.id,
                type: 'text',
                props: [prp('text', str('End'))],
            },
            { op: 'children', parent: 300, ids: [302, end.id] },
            FRAME,
        ])

        show()
        const patch = views.replace(303, {
            type: 'text',
            props: { text: 'New' },
        })
        expect(apply([FRAME])).toEqual([
            { op: 'children', parent: 300, ids: [301, 302, end.id] },
            {
                op: 'create',
                id: patch.id,
                type: 'text',
                props: [prp('text', str('New'))],
            },
            { op: 'children', parent: 302, ids: [patch.id, 303, 304] },
            { op: 'children', parent: 302, ids: [patch.id, 304] },
            FRAME,
        ])

        patch.remove()
        views.dispose()
        expect(apply([FRAME])).toEqual([
            { op: 'children', parent: 302, ids: [patch.id, 303, 304] },
            { op: 'children', parent: 302, ids: [303, 304] },
            { op: 'delete', ids: [patch.id] },
            { op: 'children', parent: 300, ids: [301, 302] },
            { op: 'delete', ids: [end.id] },
            FRAME,
        ])
    })
})

describe('props', () => {
    test('keeps overrides over Discord updates and mirrors templates', () => {
        apply(screen(400))
        const views = createViews()

        const copy = views.insert(404, 'after', {
            from: 404,
            props: { accessibilityId: 'copy' },
        })
        const undo = views.setProps(403, { text: 'Mine', color: 9 })
        expect(apply([FRAME])).toEqual([
            {
                op: 'create',
                id: copy.id,
                type: 'view',
                props: [
                    prp('background', { type: 'i32', value: 5 }),
                    ON_PRESS,
                    prp('accessibilityId', str('copy')),
                ],
            },
            { op: 'children', parent: 402, ids: [403, 404, copy.id] },
            {
                op: 'update',
                id: 403,
                props: [
                    prp('text', str('Mine')),
                    prp('color', { type: 'i64', value: 9n }),
                ],
            },
            FRAME,
        ])

        const theme: UiOp = {
            op: 'update',
            id: 404,
            props: [
                prp('background', { type: 'i32', value: 6 }),
                prp('accessibilityId', str('other')),
            ],
        }
        expect(
            apply([
                theme,
                {
                    op: 'update',
                    id: 403,
                    props: [
                        prp('text', str('Theirs')),
                        prp('fontSize', { type: 'f64', value: 3 }),
                    ],
                },
            ]),
        ).toEqual([
            theme,
            {
                op: 'update',
                id: copy.id,
                props: [prp('background', { type: 'i32', value: 6 })],
            },
            {
                op: 'update',
                id: 403,
                props: [
                    prp('text', str('Mine')),
                    prp('fontSize', { type: 'f64', value: 3 }),
                ],
            },
        ])

        undo()
        expect(apply([FRAME])).toEqual([
            {
                op: 'update',
                id: 403,
                props: [
                    prp('text', str('Theirs')),
                    prp('color', { type: 'i64', value: 1n }),
                ],
            },
            FRAME,
        ])
        views.dispose()
        apply([FRAME])
    })
})

describe('events', () => {
    test('routes presses on inserted and existing nodes', () => {
        apply(screen(500))
        const views = createViews()
        const seen: string[] = []

        const patch = views.insert(500, 'start', {
            type: 'view',
            on: { press: event => void seen.push(`ours ${event.node}`) },
        })
        views.on(503, 'press', () => void seen.push('header'))
        const off = views.on(504, 'press', () => {
            seen.push('row')
            return false
        })
        expect(apply([FRAME])).toEqual([
            { op: 'create', id: patch.id, type: 'view', props: [ON_PRESS] },
            { op: 'children', parent: 500, ids: [patch.id, 501, 502] },
            { op: 'update', id: 503, props: [ON_PRESS] },
            FRAME,
        ])

        expect(press(patch.id)).toEqual([])
        expect(press(patch.id, 'longPress')).toEqual([])
        expect(press(503)).toEqual([])
        expect(press(504)).toEqual([])
        off()
        views.on(504, 'press', () => {})
        expect(press(504)).toBeUndefined()
        expect(press(501)).toBeUndefined()
        expect(seen).toEqual([`ours ${patch.id}`, 'header', 'row'])

        views.dispose()
        expect(apply([FRAME])).toContainEqual({
            op: 'update',
            id: 503,
            props: [prp('on', { type: 'null' })],
        })
    })
})

describe('failures', () => {
    test('log and leave the batch alone', () => {
        const views = createViews()
        logs.length = 0

        expect(frames.onApplyOps!(new Uint8Array([2, 8]))).toBeUndefined()
        views.watch({ type: 'boom' }, () => {
            throw new Error('plugin bug')
        })
        expect(
            apply([{ op: 'create', id: 600, type: 'boom', props: [] }]),
        ).toBeUndefined()
        expect(views.insert(-5, 'end', { type: 'view' }).removed).toBe(true)
        expect(views.insert(600, 'end', { from: -5 }).id).toBe(-1)
        expect(
            views.insert(600, 'end', { type: 'view', props: { nope: 1 } }),
        ).toMatchObject({ removed: false })
        expect(logs).toEqual([
            expect.stringContaining('Unsupported UI op version 2'),
            expect.stringContaining('plugin bug'),
            expect.stringContaining('No node -5'),
            expect.stringContaining('No template node -5'),
            expect.stringContaining('Unknown prop nope'),
        ])

        views.dispose()
        apply([FRAME])
    })
})
