import { callNativeMethodSync } from '@valenced/modules/native'
import { ByteReader, ByteWriter, decodeUtf8, encodeUtf8 } from './bytes'

export type UiValue =
    | { type: 'null' }
    | { type: 'bool'; value: boolean }
    | { type: 'i32'; value: number }
    | { type: 'i64'; value: bigint }
    | { type: 'f64'; value: number }
    | { type: 'str'; value: string }
    | { type: 'arr'; value: UiValue[] }
    | { type: 'obj'; value: UiProp[] }
    | { type: 'rect'; value: [number, number, number, number] }
    | { type: 'map'; value: [string, UiValue][] }
    | { type: 'words'; value: number[] }
    /** Copy of an earlier `words` list in the same batch, with words replaced. */
    | { type: 'wpatch'; list: number; patches: [number, number][] }

/** Key indexes the client's prop name table, see {@link propName}. */
export interface UiProp {
    key: number
    value: UiValue
}

export type UiOp =
    | { op: 'create'; id: number; type: string; props: UiProp[] }
    | { op: 'update'; id: number; props: UiProp[] }
    | { op: 'children'; parent: number; ids: number[] }
    | { op: 'delete'; ids: number[] }
    | { op: 'root'; id: number }
    | { op: 'focus'; id: number | null }
    | { op: 'scrollTo'; id: number; value: UiValue }
    | { op: 'requestFrame' }
    | { op: 'motion'; words: number[] }
    | { op: 'childEdits'; parent: number; edits: UiChildEdit[] }

/** Keeps `keep` cached children, skips `del`, then inserts `ins`. */
export interface UiChildEdit {
    keep: number
    del: number
    ins: number[]
}

/** Event from the host for a node subscribed through the `on` prop. */
export interface UiViewEvent {
    node: number
    event: number
    payload: UiValue
}

let names: string[] | undefined
let keys: Map<string, number> | undefined

/** Returns the name of a prop or event key in the running client's table. */
export function propName(key: number): string | undefined {
    names ??= callNativeMethodSync('valenced.phoenix.uiProps', []) ?? []
    return names[key]
}

/** Returns the key of a prop or event name in the running client's table. */
export function propKey(name: string) {
    if (!keys) {
        names ??= callNativeMethodSync('valenced.phoenix.uiProps', []) ?? []
        keys = new Map(names.map((name, key) => [name, key]))
    }

    return keys.get(name)
}

const OPS = [
    'create',
    'update',
    'children',
    'delete',
    'root',
    'focus',
    'scrollTo',
    'requestFrame',
    'motion',
    'childEdits',
] as const

/**
 * Decodes an op batch from `GuestHost.applyOps`.
 *
 * @param length Valid byte count. The client reuses one large buffer, so bytes past it are stale.
 */
export function decodeOps(bytes: Uint8Array, length = bytes.length) {
    const reader = new ByteReader(bytes.subarray(0, length))

    const version = reader.u8()
    if (version !== 1) throw new Error(`Unsupported UI op version ${version}`)

    const ops: UiOp[] = []
    while (reader.remaining) {
        const code = reader.u8()

        switch (OPS[code - 1]) {
            case 'create':
                ops.push({
                    op: 'create',
                    id: reader.i32(),
                    type: decodeUtf8(reader.raw(reader.u16())),
                    props: readProps(reader, reader.u16()),
                })
                break
            case 'update':
                ops.push({
                    op: 'update',
                    id: reader.i32(),
                    props: readProps(reader, reader.u16()),
                })
                break
            case 'children':
                ops.push({
                    op: 'children',
                    parent: reader.i32(),
                    ids: readWords(reader),
                })
                break
            case 'delete':
                ops.push({ op: 'delete', ids: readWords(reader) })
                break
            case 'root':
                ops.push({ op: 'root', id: reader.i32() })
                break
            case 'focus':
                ops.push({ op: 'focus', id: reader.u8() ? reader.i32() : null })
                break
            case 'scrollTo':
                ops.push({
                    op: 'scrollTo',
                    id: reader.i32(),
                    value: readValue(reader),
                })
                break
            case 'requestFrame':
                ops.push({ op: 'requestFrame' })
                break
            case 'motion':
                ops.push({ op: 'motion', words: readWords(reader) })
                break
            case 'childEdits': {
                const parent = reader.i32()
                const edits: UiChildEdit[] = []
                for (let i = reader.i32(); i > 0; i--)
                    edits.push({
                        keep: reader.i32(),
                        del: reader.i32(),
                        ins: readWords(reader),
                    })
                ops.push({ op: 'childEdits', parent, edits })
                break
            }
            default:
                throw new Error(
                    `Unknown UI op ${code} at byte ${reader.offset - 1}`,
                )
        }
    }

    return ops
}

/** Encodes ops as a version 1 batch for `GuestHost.applyOps`. */
export function encodeOps(ops: UiOp[]) {
    const writer = new ByteWriter().u8(1)

    for (const op of ops) {
        writer.u8(OPS.indexOf(op.op) + 1)

        switch (op.op) {
            case 'create': {
                const type = encodeUtf8(op.type)
                writer.i32(op.id).u16(type.length).raw(type)
                writer.u16(op.props.length)
                writeProps(writer, op.props)
                break
            }
            case 'update':
                writer.i32(op.id).u16(op.props.length)
                writeProps(writer, op.props)
                break
            case 'children':
                writer.i32(op.parent)
                writeWords(writer, op.ids)
                break
            case 'delete':
                writeWords(writer, op.ids)
                break
            case 'root':
                writer.i32(op.id)
                break
            case 'focus':
                if (op.id === null) writer.u8(0)
                else writer.u8(1).i32(op.id)
                break
            case 'scrollTo':
                writer.i32(op.id)
                writeValue(writer, op.value)
                break
            case 'requestFrame':
                break
            case 'motion':
                writeWords(writer, op.words)
                break
            case 'childEdits':
                writer.i32(op.parent).i32(op.edits.length)
                for (const edit of op.edits) {
                    writer.i32(edit.keep).i32(edit.del)
                    writeWords(writer, edit.ins)
                }
                break
        }
    }

    return writer.toBytes()
}

/**
 * Finds colors in props with a nonzero role, without decoding the batch: i32 and i64 values, and
 * opaque colors in word lists. Values in arrays and objects take the role of the outer prop, or
 * their own role when it has none.
 *
 * @returns Flat `[offset, role, color]` triples, with `offset` at the color's low 32 bits.
 */
export function findColors(bytes: Uint8Array, roles: ArrayLike<number>) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    const found: number[] = []
    let i = 0

    const skipWords = () => {
        i += 4 + 4 * view.getInt32(i, true)
    }
    const readWord = (role: number) => {
        if (role && bytes[i + 3] === 0xff)
            found.push(i, role, view.getUint32(i, true))
        i += 4
    }
    const readProps = (count: number, outer: number) => {
        for (; count > 0; count--) {
            const key = view.getUint16(i, true)
            i += 2
            readValue(outer || roles[key] || 0)
        }
    }
    const readValue = (role: number) => {
        const tag = bytes[i++]!
        switch (tag) {
            case 3:
                if (role) found.push(i, role, view.getUint32(i, true))
                i += 4
                break
            case 4:
                if (role && !view.getUint32(i + 4, true))
                    found.push(i, role, view.getUint32(i, true))
                i += 8
                break
            case 5:
                i += 8
                break
            case 6:
                i += 4 + view.getInt32(i, true)
                break
            case 7:
            case 8:
            case 10: {
                let count = view.getInt32(i, true)
                i += 4
                if (tag === 8) readProps(count, role)
                else
                    for (; count > 0; count--) {
                        if (tag === 10) i += 4 + view.getInt32(i, true)
                        readValue(role)
                    }
                break
            }
            case 9:
                i += 16
                break
            case 11:
                for (
                    let count = view.getInt32((i += 4) - 4, true);
                    count > 0;
                    count--
                )
                    readWord(role)
                break
            case 12:
                i += 6
                for (
                    let count = view.getUint16(i - 2, true);
                    count > 0;
                    count--
                ) {
                    i += 2
                    readWord(role)
                }
                break
            default:
                if (tag > 2)
                    throw new Error(
                        `Unknown UI value tag ${tag} at byte ${i - 1}`,
                    )
        }
    }

    if (bytes[i++] !== 1)
        throw new Error(`Unsupported UI op version ${bytes[0]}`)

    while (i < bytes.length) {
        const code = bytes[i++]!
        switch (OPS[code - 1]) {
            case 'create':
                i += 4
                i += 2 + view.getUint16(i, true)
                i += 2
                readProps(view.getUint16(i - 2, true), 0)
                break
            case 'update':
                i += 6
                readProps(view.getUint16(i - 2, true), 0)
                break
            case 'children':
                i += 4
                skipWords()
                break
            case 'delete':
            case 'motion':
                skipWords()
                break
            case 'root':
                i += 4
                break
            case 'focus':
                i += bytes[i] ? 5 : 1
                break
            case 'scrollTo':
                i += 4
                readValue(0)
                break
            case 'requestFrame':
                break
            case 'childEdits':
                i += 8
                for (
                    let count = view.getInt32(i - 4, true);
                    count > 0;
                    count--
                ) {
                    i += 8
                    skipWords()
                }
                break
            default:
                throw new Error(`Unknown UI op ${code} at byte ${i - 1}`)
        }
    }

    return found
}

/**
 * Splits a `nativeDispatch` frame into its events. A batch (kind 4) holds several, anything else
 * is one event.
 */
export function splitDispatch(bytes: Uint8Array) {
    const reader = new ByteReader(bytes)
    if (reader.u16() !== 4) return [bytes]

    reader.raw(10)
    reader.raw(reader.u32())

    const frames: Uint8Array[] = []
    while (reader.remaining) frames.push(reader.raw(reader.u32()))
    return frames
}

/** Joins events into a batch (kind 4) for `nativeDispatch`. */
export function joinDispatch(frames: Uint8Array[]) {
    const writer = new ByteWriter().u16(4).raw(new Uint8Array(14))
    for (const frame of frames) writer.u32(frame.length).raw(frame)
    return writer.toBytes()
}

/** Decodes a view event, or returns `undefined` for other event kinds. */
export function decodeViewEvent(frame: Uint8Array): UiViewEvent | undefined {
    const reader = new ByteReader(frame)
    if (reader.u32() !== 0 || reader.u8() !== 1 || reader.u8() !== 1) return

    return {
        node: reader.i32(),
        event: reader.u16(),
        payload: readValue(reader),
    }
}

/** Encodes a view event, as the host does for a press or a text change. */
export function encodeViewEvent({ node, event, payload }: UiViewEvent) {
    const writer = new ByteWriter().u32(0).u8(1).u8(1).i32(node).u16(event)
    writeValue(writer, payload)
    return writer.toBytes()
}

function readWords(reader: ByteReader) {
    const words: number[] = []
    for (let i = reader.i32(); i > 0; i--) words.push(reader.i32())
    return words
}

function writeWords(writer: ByteWriter, words: number[]) {
    writer.i32(words.length)
    for (const word of words) writer.i32(word)
}

function readProps(reader: ByteReader, count: number) {
    const props: UiProp[] = []
    for (let i = count; i > 0; i--)
        props.push({ key: reader.u16(), value: readValue(reader) })
    return props
}

function writeProps(writer: ByteWriter, props: UiProp[]) {
    for (const prop of props) {
        writer.u16(prop.key)
        writeValue(writer, prop.value)
    }
}

function readValue(reader: ByteReader): UiValue {
    const tag = reader.u8()

    switch (tag) {
        case 0:
            return { type: 'null' }
        case 1:
            return { type: 'bool', value: false }
        case 2:
            return { type: 'bool', value: true }
        case 3:
            return { type: 'i32', value: reader.i32() }
        case 4:
            return { type: 'i64', value: reader.i64() }
        case 5:
            return { type: 'f64', value: reader.f64() }
        case 6:
            return { type: 'str', value: decodeUtf8(reader.raw(reader.i32())) }
        case 7: {
            const value: UiValue[] = []
            for (let i = reader.i32(); i > 0; i--) value.push(readValue(reader))
            return { type: 'arr', value }
        }
        case 8:
            return { type: 'obj', value: readProps(reader, reader.i32()) }
        case 9:
            return {
                type: 'rect',
                value: [reader.f32(), reader.f32(), reader.f32(), reader.f32()],
            }
        case 10: {
            const value: [string, UiValue][] = []
            for (let i = reader.i32(); i > 0; i--)
                value.push([
                    decodeUtf8(reader.raw(reader.i32())),
                    readValue(reader),
                ])
            return { type: 'map', value }
        }
        case 11:
            return { type: 'words', value: readWords(reader) }
        case 12: {
            const list = reader.i32()
            const patches: [number, number][] = []
            for (let i = reader.u16(); i > 0; i--)
                patches.push([reader.u16(), reader.i32()])
            return { type: 'wpatch', list, patches }
        }
        default:
            throw new Error(
                `Unknown UI value tag ${tag} at byte ${reader.offset - 1}`,
            )
    }
}

function writeValue(writer: ByteWriter, value: UiValue) {
    switch (value.type) {
        case 'null':
            writer.u8(0)
            break
        case 'bool':
            writer.u8(value.value ? 2 : 1)
            break
        case 'i32':
            writer.u8(3).i32(value.value)
            break
        case 'i64':
            writer.u8(4).i64(value.value)
            break
        case 'f64':
            writer.u8(5).f64(value.value)
            break
        case 'str': {
            const utf8 = encodeUtf8(value.value)
            writer.u8(6).i32(utf8.length).raw(utf8)
            break
        }
        case 'arr':
            writer.u8(7).i32(value.value.length)
            for (const item of value.value) writeValue(writer, item)
            break
        case 'obj':
            writer.u8(8).i32(value.value.length)
            writeProps(writer, value.value)
            break
        case 'rect':
            writer.u8(9)
            for (const side of value.value) writer.f32(side)
            break
        case 'map':
            writer.u8(10).i32(value.value.length)
            for (const [key, item] of value.value) {
                const utf8 = encodeUtf8(key)
                writer.i32(utf8.length).raw(utf8)
                writeValue(writer, item)
            }
            break
        case 'words':
            writer.u8(11)
            writeWords(writer, value.value)
            break
        case 'wpatch':
            writer.u8(12).i32(value.list).u16(value.patches.length)
            for (const [index, word] of value.patches)
                writer.u16(index).i32(word)
            break
    }
}

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.phoenix.uiProps': [[], string[] | null]
    }
}
