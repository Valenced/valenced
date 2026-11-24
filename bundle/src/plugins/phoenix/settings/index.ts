import { callNativeMethod } from '@valenced/modules/native'
import { onDispatch, onOps } from '@valenced/phoenix'
import { encodeUtf8 } from '@valenced/phoenix/bytes'
import {
    decodeOps,
    decodeViewEvent,
    encodeOps,
    joinDispatch,
    propKey,
    splitDispatch,
} from '@valenced/phoenix/ui'
import { BuildEnvironment, FullVersion } from '~constants'
import ValencedDonate from '../../../assets/ValencedDonate.webp'
import ValencedIcon from '../../../assets/ValencedIcon.webp'
import type { UiOp, UiProp, UiValue } from '@valenced/phoenix/ui'

const SCREEN = encodeUtf8('settings-phone')
const RADII = [
    'radiusTopLeft',
    'radiusTopRight',
    'radiusBottomLeft',
    'radiusBottomRight',
]

interface Screen {
    list: number
    anchor: number
    section: number
    rows: Record<number, string>
    ids: number[]
    guest: number[]
    theme: Record<string, number | undefined>
    pending?: UiOp[]
}

let screen: Screen | undefined
let enabled: number | undefined
// Clear of the guest's own ids
let nextId = 0x50000000

const prop = (props: UiProp[], name: string) =>
    props.find(it => it.key === propKey(name))?.value

function color(props: UiProp[] | undefined, name: string) {
    const value = props && prop(props, name)
    if (value?.type === 'i64') return Number(value.value)
    if (value?.type === 'i32') return value.value >>> 0
}

function withProps(props: UiProp[], values: Record<string, UiValue | null>) {
    const keys = Object.keys(values).map(name => propKey(name))
    const out = props.filter(it => !keys.includes(it.key))
    for (const [name, value] of Object.entries(values)) {
        const key = propKey(name)
        if (value && key !== undefined) out.push({ key, value })
    }
    return out
}

function withOurs(ids: number[]) {
    const at = ids.indexOf(screen!.anchor)
    return at < 0
        ? ids
        : [...ids.slice(0, at), screen!.section, ...ids.slice(at)]
}

function inject(ops: UiOp[]): Screen | undefined {
    const creates = new Map<number, Extract<UiOp, { op: 'create' }>>()
    const kids = new Map<number, number[]>()
    const parents = new Map<number, number>()

    for (const op of ops) {
        if (op.op === 'create') creates.set(op.id, op)
        else if (op.op === 'children') {
            kids.set(op.parent, op.ids)
            for (const id of op.ids) parents.set(id, op.parent)
        }
    }

    const logout = [...creates.values()].find(it => {
        const id = prop(it.props, 'accessibilityId')
        return id?.type === 'str' && id.value === 'settings.row.logout'
    })
    const list = parents.get(
        parents.get(parents.get(logout?.id ?? -1) ?? -1) ?? -1,
    )
    if (list === undefined) return

    for (const section of kids.get(list) ?? []) {
        const [header, card] = kids.get(section) ?? []
        const row = kids.get(card)?.[0]
        const inner = kids.get(row ?? -1)?.[0]
        const parts = (kids.get(inner ?? -1) ?? []).map(id => creates.get(id))
        const icon = parts.find(it => it?.type === 'image')
        const label = parts.find(it => it?.type === 'text')
        const chevron = parts.at(-1)
        const arrow = creates.get(kids.get(chevron?.id ?? -1)?.[0] ?? -1)

        const nodes = [section, header, card, row, inner].map(id =>
            creates.get(id ?? -1),
        )
        if (
            nodes.some(it => !it) ||
            nodes[1]!.type !== 'text' ||
            !icon ||
            !label ||
            chevron?.type !== 'view' ||
            arrow?.type !== 'image'
        )
            continue

        const [s, h, c, r, i] = nodes as Extract<UiOp, { op: 'create' }>[]
        const ids = Array.from({ length: 19 }, () => nextId++)
        const [sId, hId, cId, dId, lineId] = ids
        const radius = prop(c.props, 'radius') ?? { type: 'f64', value: 12 }
        const str = (value: string): UiValue => ({ type: 'str', value })
        const size = (name: string, value: number): UiValue =>
            prop(label.props, name)?.type === 'i32'
                ? { type: 'i32', value }
                : { type: 'f64', value }
        const all = [...creates.values()]
        const page = all.find(it => {
            const id = prop(it.props, 'accessibilityId')
            return id?.type === 'str' && id.value === 'settings-phone'
        })
        const input = all.find(it => it.type === 'input')
        const field = creates.get(
            parents.get(parents.get(input?.id ?? -1) ?? -1) ?? -1,
        )
        const divider = all.find(it => {
            const height = prop(it.props, 'height')
            return (
                height?.type === 'f64' &&
                height.value === 1 &&
                color(it.props, 'background') !== undefined
            )
        })
        const gap = creates.get(parents.get(divider?.id ?? -1) ?? -1)
        const theme = {
            background: color(page?.props, 'background'),
            card: color(r.props, 'background'),
            pressed: color(r.props, 'activeBackground'),
            divider: color(divider?.props, 'background'),
            text: color(label.props, 'color'),
            muted: color(h.props, 'color'),
            danger: color(
                kids
                    .get(kids.get(logout?.id ?? -1)?.[0] ?? -1)
                    ?.map(id => creates.get(id))
                    .find(it => it?.type === 'text')?.props,
                'color',
            ),
            field: color(field?.props, 'background'),
            outline: color(field?.props, 'borderColor'),
        }

        const rows: Record<number, string> = {}
        const ops: UiOp[] = []
        const entries = [
            ['valenced', 'Valenced', ValencedIcon, FullVersion],
            [
                'plugins',
                'Plugins',
                'res://design_components_icon_native_redesign_generated_images_puzzlepieceicon',
                enabled === undefined ? undefined : `${enabled} enabled`,
            ],
        ] as const
        const rowIds = entries.map(([key, name, uri, value], at) => {
            const [
                rowId,
                innerId,
                iconId,
                labelId,
                valueId,
                chevronId,
                arrowId,
            ] = ids.slice(5 + at * 7)
            rows[rowId] = key
            ops.push(
                {
                    op: 'create',
                    id: rowId,
                    type: r.type,
                    props: withProps(r.props, {
                        ...Object.fromEntries(RADII.map(name => [name, null])),
                        radius: null,
                        ...(at === 0
                            ? { radiusTopLeft: radius, radiusTopRight: radius }
                            : {
                                  radiusBottomLeft: radius,
                                  radiusBottomRight: radius,
                              }),
                        accessibilityLabel: str(name),
                        accessibilityId: str(`valenced.row.${key}`),
                    }),
                },
                { op: 'create', id: innerId, type: i.type, props: i.props },
                {
                    op: 'create',
                    id: iconId,
                    type: icon.type,
                    props: withProps(icon.props, { uri: str(uri) }),
                },
                {
                    op: 'create',
                    id: labelId,
                    type: label.type,
                    props: withProps(label.props, { text: str(name) }),
                },
                {
                    op: 'create',
                    id: chevronId,
                    type: chevron.type,
                    props: chevron.props,
                },
                {
                    op: 'create',
                    id: arrowId,
                    type: arrow.type,
                    props: arrow.props,
                },
                { op: 'children', parent: chevronId, ids: [arrowId] },
            )
            if (value !== undefined)
                ops.push({
                    op: 'create',
                    id: valueId,
                    type: label.type,
                    props: withProps(label.props, {
                        text: str(value),
                        color: prop(arrow.props, 'tint') ?? null,
                        fontSize: size('fontSize', 14),
                        lineHeight: size('lineHeight', 18),
                        flex: null,
                    }),
                })
            ops.push(
                {
                    op: 'children',
                    parent: innerId,
                    ids:
                        value === undefined
                            ? [iconId, labelId, chevronId]
                            : [iconId, labelId, valueId, chevronId],
                },
                { op: 'children', parent: rowId, ids: [innerId] },
            )
            return rowId
        })
        if (gap && divider)
            ops.push(
                { op: 'create', id: dId, type: gap.type, props: gap.props },
                {
                    op: 'create',
                    id: lineId,
                    type: divider.type,
                    props: divider.props,
                },
                { op: 'children', parent: dId, ids: [lineId] },
            )

        return {
            list,
            anchor: section,
            section: sId,
            rows,
            ids,
            guest: kids.get(list)!,
            theme,
            pending: [
                { op: 'create', id: sId, type: s.type, props: s.props },
                {
                    op: 'create',
                    id: hId,
                    type: h.type,
                    props: withProps(h.props, { text: str('Valenced') }),
                },
                { op: 'create', id: cId, type: c.type, props: c.props },
                ...ops,
                {
                    op: 'children',
                    parent: cId,
                    ids: gap && divider ? [rowIds[0], dId, rowIds[1]] : rowIds,
                },
                { op: 'children', parent: sId, ids: [hId, cId] },
            ],
        }
    }
}

// Plugin system methods resolve { result } or { error }
async function countEnabled() {
    const [list, slots, states] = (
        await Promise.all([
            callNativeMethod('valenced.plugins.list', []),
            callNativeMethod('valenced.plugins.states.getSlots', []),
            callNativeMethod('valenced.plugins.states.read', []),
        ])
    ).map(it => (it as { result?: unknown } | null)?.result) as [
        PluginEntry[] | undefined,
        { active: string } | undefined,
        Record<string, Record<string, { enabled?: boolean }>> | undefined,
    ]
    if (!list || !slots || !states) return

    const active = states[slots.active] ?? {}
    enabled = list.filter(it => {
        const entry = active[it.manifest.id]
        return (
            entry?.enabled === true ||
            it.essential ||
            (it.enabledByDefault && !entry)
        )
    }).length
}

interface PluginEntry {
    manifest: { id: string }
    essential: boolean
    enabledByDefault: boolean
}

countEnabled()

onOps(bytes => {
    if (!screen) {
        let found = false
        for (let i = 0; !found && i <= bytes.length - SCREEN.length; i++)
            found = SCREEN.every((byte, j) => bytes[i + j] === byte)
        if (!found) return
    }

    try {
        const ops = decodeOps(bytes)
        if (!screen) {
            screen = inject(ops)
            if (!screen) {
                nativeLoggingHook('No Valenced row, Settings layout unknown', 2)
                return
            }
            countEnabled()
        }

        let changed = false
        const out: UiOp[] = []

        for (const op of ops) {
            if (op.op === 'children' && op.parent === screen.list) {
                if (screen.pending) out.push(...screen.pending)
                screen.pending = undefined
                screen.guest = op.ids
                out.push({ ...op, ids: withOurs(op.ids) })
                changed = true
            } else if (op.op === 'childEdits' && op.parent === screen.list) {
                const ids: number[] = []
                let cursor = 0
                for (const edit of op.edits) {
                    ids.push(...screen.guest.slice(cursor, cursor + edit.keep))
                    cursor += edit.keep + edit.del
                    ids.push(...edit.ins)
                }
                ids.push(...screen.guest.slice(cursor))

                screen.guest = ids
                out.push({
                    op: 'children',
                    parent: op.parent,
                    ids: withOurs(ids),
                })
                changed = true
            } else if (op.op === 'delete' && op.ids.includes(screen.list)) {
                // Java's delete does not recurse
                out.push({ op: 'delete', ids: [...op.ids, ...screen.ids] })
                screen = undefined
                changed = true
            } else out.push(op)

            if (!screen) {
                out.push(...ops.slice(ops.indexOf(op) + 1))
                break
            }
        }

        if (changed) return encodeOps(out)
    } catch (e) {
        screen = undefined
        nativeLoggingHook(`Valenced row failed: ${e}`, 2)
    }
})

onDispatch((_, bytes) => {
    if (!screen) return

    const frames = splitDispatch(bytes)
    const kept = frames.filter(frame => {
        const event = decodeViewEvent(frame)
        if (!event || !screen!.ids.includes(event.node)) return true

        const page = screen!.rows[event.node]
        if (page && event.event === propKey('press'))
            callNativeMethod('valenced.phoenix.openSettings', [
                screen!.theme,
                {
                    page,
                    version: `${FullVersion} (${BuildEnvironment})`,
                    discord: __BUILD_DISCORD_SERVER_URL__,
                    source: __BUILD_SOURCE_REPOSITORY_URL__,
                    license: __BUILD_LICENSE_URL__,
                    donate: __BUILD_DONATE_URL__,
                    donateImage: ValencedDonate,
                    defaultRepo: __BUILD_DEFAULT_PLUGIN_REPOSITORY_URL__,
                    icon: ValencedIcon,
                },
            ])
        return false
    })

    if (kept.length !== frames.length) return joinDispatch(kept)
})

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.phoenix.openSettings': [
            [
                Record<string, number | undefined>,
                Record<string, string | undefined>,
            ],
            null,
        ]
    }
}
