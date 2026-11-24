import { describe, expect, test } from 'vitest'
import {
    decodeOps,
    decodeViewEvent,
    encodeOps,
    encodeViewEvent,
    findColors,
    joinDispatch,
    propKey,
    propName,
    splitDispatch,
} from './ui'
import type { UiOp, UiValue } from './ui'

const hex = (value: string) =>
    Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16))

// Frames captured from Discord 356207 on an emulator.
const POPOVER =
    '01017b0400000700706f706f7665720a0065010606000000626f74746f6d3f00060600000063656e7465723d010500000000000020c0ac00050000000000002840590102980001dd020b7d000000ed5524950000000002000000070000000000803f0200000000000000a8010000ffffffff010000000000c07f0000c07f00000000000000c10000000000000000010000000000003f0000e14300000c42010000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000803f0000c84200002041000000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000803f0000c84200002041000000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000c07f0000c07f00000000a9010000ffffffff010000000000c07f0000c07f00000000000000c10000000000000000010000000000003f0000e14300000c42010000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000803f0000c84200002041000000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000803f0000c84200002041000000000ad7233c00000040000000000000000000000000000000000000000000000000000000000000c07f0000c07f00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe4020703000000031b00000004ffffffff0000000003a9010000420105000000000000000018020500000000000020c0017c040000040076696577020093000606000000636f6c756d6e3f00060600000063656e746572017d040000040076696577030093000606000000636f6c756d6e3f00060600000063656e746572710102017e04000004007669657707004c0109000000400000004000000040000000402902050000000000002040eb000500000000000020408401050000000000001040680004fbfbfbff000000006b000500000000000000403f00060700000073747265746368017f04000004007669657704002902050000000000000040eb000500000000000024405a0004fbfbfbff000000003f00060700000073747265746368037d040000020000007e0400007f04000001800400000500737461636b07004c01090000803f0000803f0000803f0000803f2902050000000000006e405a0004292424ff0000000084010500000000000030406800039f97971f6b0005000000000000f03f4001070100000006130000006163636573736962696c69747945736361706501810400000500737461636b06000000024d01022902060400000066696c6ceb00060400000066696c6c0700024001070100000006050000007072657373018204000004007669657703004c0109000080410000804100008041000080412902060400000066696c6c3f000607000000737472657463680183040000040076696577040093000606000000636f6c756d6e2902060400000066696c6c3f00060600000063656e7465720401060600000063656e7465720184040000040076696577050093000606000000636f6c756d6e3f00060600000063656e7465729e010605000000616c6572740b0006670000005374796c6520796f757220646973706c6179206e616d652c204769766520796f757220646973706c6179206e616d6520736f6d6520666c6169722077697468206e657720666f6e747320616e6420656666656374732e204f6e6c792077697468204e6974726f2e06000301000000018504000004007669657702001f0109000000000000000000000000000080413f0006070000007374726574636801860400000500696d61676505001e02066e00000068747470733a2f2f63646e2e646973636f72646170702e636f6d2f6173736574732f636f6e74656e742f373034343537373762643266633965363733326163333564386665393066646330666137383461623738616261333231353732366438333234306532383639632e706e671f0109000000800000000000000080000000002902050000000000006440eb00050000000000005140ac010603000000666974038504000001000000860400000187040000040076696577030093000606000000636f6c756d6edc000500000000000010403f00060600000063656e74657201880400000400746578740900f30106170000005374796c6520796f757220646973706c6179206e616d65810004fbfbfbff00000000cf00050000000000003040d00003580200001601050000000000003440170102f401060600000063656e7465724c01090000c041000000000000c04100000000280105000000000000694001890400000400746578740800f301064e0000004769766520796f757220646973706c6179206e616d6520736f6d6520666c6169722077697468206e657720666f6e747320616e6420656666656374732e204f6e6c792077697468204e6974726f2e810004b2acabff00000000cf00050000000000002c40d00003f40100001601050000000000003240170102f401060600000063656e7465722801050000000000006940038704000002000000880400008904000003840400000200000085040000870400000383040000010000008404000003820400000100000083040000018a0400000500737461636b07000000024d0102e3000607000000746f707c656e641f0109000000000000804100008041000000009e010606000000627574746f6e0b000605000000436c6f73654001070100000006050000007072657373018b0400000500696d61676505001e0206150000007265733a2f2f69635f6d616e615f785f736d616c6c2902050000000000003040eb000500000000000030400a0204fbfbfbff00000000ac010603000000666974038a040000010000008b04000003800400000300000081040000820400008a040000037c040000020000007d04000080040000037b040000010000007c0400000314040000030000007b0400001504000016040000091200000008000000a80100000000000002000000a801000000000000020000000000803f0000003f0000e14300000c42010000000ad7233c000000400000000008000000a901000000000000'
const CHILD_EDITS =
    '010401000000bb0100000a1100000001000000030000000100000000000000'
const UPDATES =
    '0102a80300000100c50108050000008100045c6262ff0000000042010500000040e17ad43f84010500000000000014403e010500000000000000003f0105000000000000000002a903000001005a00035c626233'
const PRESS =
    '0400000000000000000000000000000011000000000000000101a801000066020800000000'
const PRESS_DOWN =
    '0400000000000000000000000000000027000000000000000101a8010000670208020000002e020500000040cff350402f0205000000809ee72940'
const MODULE =
    '030000007801000000000000250000000803000000bb0106040000006d7574654302060b0000006d69635f626c6f636b65649b0301'

describe('decodeOps', () => {
    test.each([
        ['popover', POPOVER],
        ['childEdits', CHILD_EDITS],
        ['updates', UPDATES],
        ['requestFrame', '0108'],
    ])('re-encodes the %s frame byte for byte', (_, frame) => {
        const bytes = hex(frame)
        expect(encodeOps(decodeOps(bytes))).toEqual(bytes)
    })

    test('decodes a popover', () => {
        const ops = decodeOps(hex(POPOVER))

        expect(ops).toHaveLength(29)
        expect(ops[0]).toMatchObject({
            op: 'create',
            id: 1147,
            type: 'popover',
        })
        expect(ops.at(-1)?.op).toBe('motion')
        expect(
            ops.some(
                op =>
                    op.op === 'create' &&
                    op.type === 'text' &&
                    op.props.some(
                        prop =>
                            prop.key === 499 &&
                            prop.value.type === 'str' &&
                            prop.value.value === 'Style your display name',
                    ),
            ),
        ).toBe(true)
    })

    test('decodes delete and childEdits', () => {
        expect(decodeOps(hex(CHILD_EDITS))).toEqual([
            { op: 'delete', ids: [443] },
            {
                op: 'childEdits',
                parent: 17,
                edits: [{ keep: 3, del: 1, ins: [] }],
            },
        ])
    })

    test('decodes nested obj props and wide colors', () => {
        const [shadow, background] = decodeOps(hex(UPDATES))

        expect(shadow).toEqual({
            op: 'update',
            id: 936,
            props: [
                {
                    key: 453,
                    value: {
                        type: 'obj',
                        value: [
                            {
                                key: 129,
                                value: { type: 'i64', value: 4284637788n },
                            },
                            {
                                key: 322,
                                value: {
                                    type: 'f64',
                                    value: 0.3199999928474426,
                                },
                            },
                            { key: 388, value: { type: 'f64', value: 5 } },
                            { key: 318, value: { type: 'f64', value: 0 } },
                            { key: 319, value: { type: 'f64', value: 0 } },
                        ],
                    },
                },
            ],
        })
        expect(background).toEqual({
            op: 'update',
            id: 937,
            props: [{ key: 90, value: { type: 'i32', value: 862085724 } }],
        })
    })

    test('ignores stale bytes past the length', () => {
        const buffer = new Uint8Array(64).fill(0xee)
        buffer.set(hex('0108'))

        expect(decodeOps(buffer, 2)).toEqual([{ op: 'requestFrame' }])
        expect(() => decodeOps(buffer)).toThrow(/Unknown UI op 238/)
    })

    test('rejects other versions', () => {
        expect(() => decodeOps(hex('0208'))).toThrow(/version 2/)
    })
})

describe('encodeOps', () => {
    test('round-trips every op and value type', () => {
        const ops: UiOp[] = [
            {
                op: 'create',
                id: 0x50000000,
                type: 'text',
                props: [
                    { key: 1, value: { type: 'null' } },
                    { key: 2, value: { type: 'bool', value: true } },
                    { key: 3, value: { type: 'i32', value: -1 } },
                    { key: 4, value: { type: 'i64', value: -(2n ** 63n) } },
                    { key: 5, value: { type: 'f64', value: 0.1 } },
                    {
                        key: 6,
                        value: { type: 'str', value: 'Valenced \u{1f9ea}' },
                    },
                    {
                        key: 7,
                        value: {
                            type: 'arr',
                            value: [{ type: 'bool', value: false }],
                        },
                    },
                    {
                        key: 8,
                        value: {
                            type: 'obj',
                            value: [
                                { key: 9, value: { type: 'f64', value: 2 } },
                            ],
                        },
                    },
                    {
                        key: 10,
                        value: { type: 'rect', value: [1, 2.5, -3, 0] },
                    },
                    {
                        key: 11,
                        value: {
                            type: 'map',
                            value: [['plugin', { type: 'str', value: 'id' }]],
                        },
                    },
                    { key: 12, value: { type: 'words', value: [1, -2, 3] } },
                    {
                        key: 13,
                        value: { type: 'wpatch', list: 0, patches: [[1, 7]] },
                    },
                ],
            },
            { op: 'update', id: 1, props: [] },
            { op: 'children', parent: 7, ids: [0x50000000, 2] },
            { op: 'delete', ids: [3, 4] },
            { op: 'root', id: 7 },
            { op: 'focus', id: 5 },
            { op: 'focus', id: null },
            { op: 'scrollTo', id: 6, value: { type: 'obj', value: [] } },
            { op: 'requestFrame' },
            { op: 'motion', words: [516, 517] },
            {
                op: 'childEdits',
                parent: 8,
                edits: [{ keep: 2, del: 1, ins: [0x50000000] }],
            },
        ]

        expect(decodeOps(encodeOps(ops))).toEqual(ops)
    })
})

describe('dispatch', () => {
    test('decodes a press', () => {
        const frames = splitDispatch(hex(PRESS))

        expect(frames).toHaveLength(1)
        expect(decodeViewEvent(frames[0])).toEqual({
            node: 424,
            event: 614,
            payload: { type: 'obj', value: [] },
        })
    })

    test('decodes pressDown coordinates', () => {
        const event = decodeViewEvent(splitDispatch(hex(PRESS_DOWN))[0])

        expect(event?.event).toBe(615)
        expect(event?.payload).toMatchObject({
            type: 'obj',
            value: [
                { key: 558, value: { type: 'f64' } },
                { key: 559, value: { type: 'f64' } },
            ],
        })
    })

    test.each([
        ['press', PRESS],
        ['pressDown', PRESS_DOWN],
    ])('rebuilds the %s batch byte for byte', (_, frame) => {
        const bytes = hex(frame)
        const frames = splitDispatch(bytes)

        expect(joinDispatch(frames)).toEqual(bytes)
        for (const event of frames)
            expect(encodeViewEvent(decodeViewEvent(event)!)).toEqual(event)
    })

    test('drops one event from a batch', () => {
        const press = splitDispatch(hex(PRESS))[0]
        const pressDown = splitDispatch(hex(PRESS_DOWN))[0]

        expect(
            splitDispatch(joinDispatch([pressDown, press])).filter(
                event => decodeViewEvent(event)?.event !== 614,
            ),
        ).toEqual([pressDown])
    })

    test('passes a module frame through as one event', () => {
        const bytes = hex(MODULE)

        expect(splitDispatch(bytes)).toEqual([bytes])
        expect(decodeViewEvent(bytes)).toBeUndefined()
    })
})

describe('prop names', () => {
    test('reads the table from native once', () => {
        const calls: unknown[] = []
        const seam = Symbol.for('valenced.bridge.call.sync')
        // @ts-expect-error
        globalThis[seam] = (payload: unknown) => {
            calls.push(payload)
            return { result: ['on', 'press'] }
        }

        expect(propName(1)).toBe('press')
        expect(propKey('on')).toBe(0)
        expect(propKey('missing')).toBeUndefined()
        expect(calls).toEqual([
            { valenced: { method: 'valenced.phoenix.uiProps', args: [] } },
        ])

        // @ts-expect-error
        delete globalThis[seam]
    })
})

describe('findColors', () => {
    test('finds colors by role and rewrites them in place', () => {
        const bytes = encodeOps([
            {
                op: 'create',
                id: 1,
                type: 'view',
                props: [
                    { key: 0, value: { type: 'i64', value: 0xff112233n } },
                    { key: 1, value: { type: 'i32', value: 0x20ffffff } },
                    {
                        key: 2,
                        value: {
                            type: 'obj',
                            value: [
                                {
                                    key: 0,
                                    value: { type: 'i64', value: 0xff445566n },
                                },
                            ],
                        },
                    },
                    {
                        key: 3,
                        value: {
                            type: 'arr',
                            value: [{ type: 'i64', value: 0xff778899n }],
                        },
                    },
                    {
                        key: 4,
                        value: {
                            type: 'words',
                            value: [0x3f800000, 0xffaabbcc | 0],
                        },
                    },
                    { key: 5, value: { type: 'str', value: 'text' } },
                    { key: 6, value: { type: 'i64', value: 0xff000001n } },
                ],
            },
            { op: 'children', parent: 0, ids: [1] },
            {
                op: 'update',
                id: 1,
                props: [
                    {
                        key: 4,
                        value: {
                            type: 'wpatch',
                            list: 0,
                            patches: [
                                [1, 0xffddeeff | 0],
                                [2, 7],
                            ],
                        },
                    },
                ],
            },
        ])

        const found = findColors(bytes, [1, 2, 0, 4, 5])
        const colors = found.filter((_, i) => i % 3 === 2)
        expect(colors).toEqual([
            0xff112233, 0x20ffffff, 0xff445566, 0xff778899, 0xffaabbcc,
            0xffddeeff,
        ])
        expect(found.filter((_, i) => i % 3 === 1)).toEqual([1, 2, 1, 4, 5, 5])

        const view = new DataView(bytes.buffer)
        for (let i = 0; i < found.length; i += 3)
            view.setUint32(found[i]!, 0xff000000 + i, true)

        const [create, , update] = decodeOps(bytes) as [
            Extract<UiOp, { op: 'create' }>,
            UiOp,
            Extract<UiOp, { op: 'update' }>,
        ]
        const value = (key: number) =>
            create.props.find(it => it.key === key)?.value
        expect(value(0)).toEqual({ type: 'i64', value: 0xff000000n })
        expect(value(1)).toEqual({ type: 'i32', value: 0xff000003 | 0 })
        expect(value(4)).toEqual({
            type: 'words',
            value: [0x3f800000, 0xff00000c | 0],
        })
        expect(value(6)).toEqual({ type: 'i64', value: 0xff000001n })
        expect(update.props[0]?.value).toMatchObject({
            patches: [
                [1, 0xff00000f | 0],
                [2, 7],
            ],
        })
    })

    test('walks captured frames', () => {
        const ints = (value: UiValue): number =>
            value.type === 'i32' || value.type === 'i64'
                ? 1
                : value.type === 'arr'
                  ? value.value.reduce((sum, it) => sum + ints(it), 0)
                  : value.type === 'obj'
                    ? value.value.reduce((sum, it) => sum + ints(it.value), 0)
                    : 0

        for (const frame of [POPOVER, CHILD_EDITS, UPDATES]) {
            const bytes = hex(frame)
            const expected = decodeOps(bytes).reduce(
                (sum, op) =>
                    sum +
                    ('props' in op
                        ? op.props.reduce(
                              (total, it) => total + ints(it.value),
                              0,
                          )
                        : 0),
                0,
            )
            const words = decodeOps(bytes)
                .flatMap(op => ('props' in op ? op.props : []))
                .flatMap(it =>
                    it.value.type === 'words' ? it.value.value : [],
                )
                .filter(word => word >>> 24 === 0xff).length

            expect(findColors(bytes, new Array(1024).fill(1)).length / 3).toBe(
                expected + words,
            )
        }
    })
})
