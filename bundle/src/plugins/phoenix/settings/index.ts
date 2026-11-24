import { callNativeMethod } from '@valenced/modules/native'
import { createViews } from '@valenced/phoenix/views'
import { BuildEnvironment, FullVersion } from '~constants'
import ValencedDonate from '../../../assets/ValencedDonate.webp'
import ValencedIcon from '../../../assets/ValencedIcon.webp'
import type { ViewNode, ViewPatch, ViewSpec } from '@valenced/phoenix/views'

const views = createViews()

interface Screen {
    list: number
    bar: number
    input: number
    patch?: ViewPatch
    template?: ReturnType<typeof template>
    hidden: Array<() => void>
}

const DIVIDER = {
    where: (it: ViewNode) => {
        const height = views.prop(it, 'height')
        return (
            height?.type === 'f64' &&
            height.value === 1 &&
            color(it, 'background') !== undefined
        )
    },
}

let screen: Screen | undefined
let enabled: number | undefined

function color(node: number | ViewNode | undefined, name: string) {
    const value = node === undefined ? undefined : views.prop(node, name)
    if (value?.type === 'i64') return Number(value.value)
    if (value?.type === 'i32') return value.value >>> 0
}

function template(list: number) {
    for (const section of views.node(list)?.children ?? []) {
        const [header, card] = views.node(section)?.children ?? []
        const row = views.node(card)?.children[0]
        const inner = views.node(row ?? -1)?.children[0]
        const parts = (views.node(inner ?? -1)?.children ?? []).map(id =>
            views.node(id),
        )
        const icon = parts.find(it => it?.type === 'image')
        const label = views.find({ type: 'text' }, inner ?? -1)
        const wrap =
            label?.parent === inner
                ? undefined
                : views.node(label?.parent ?? -1)
        const chevron = parts.at(-1)
        const arrow = views.node(chevron?.children[0] ?? -1)

        const nodes = [section, header, card, row, inner].map(id =>
            views.node(id ?? -1),
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

        const [s, h, c, r, i] = nodes as ViewNode[]
        return { s, h, c, r, i, icon, label, wrap, chevron, arrow }
    }
}

function inject() {
    if (!screen || (screen.patch && !screen.patch.removed)) return
    const t = template(screen.list)
    if (!t) return

    const page = views.find({ accessibilityId: 'settings-phone' })
    const divider = views.find(DIVIDER, page?.id)
    const gap = views.node(divider?.parent ?? -1)
    const radius = views.prop(t.c, 'radius') ?? { type: 'f64', value: 12 }

    const rows = (
        [
            ['valenced', 'Valenced', ValencedIcon, FullVersion],
            [
                'plugins',
                'Plugins',
                'res://design_components_icon_native_redesign_generated_images_puzzlepieceicon',
                enabled === undefined ? undefined : `${enabled} enabled`,
            ],
        ] as const
    ).map(
        ([key, name, uri, value], at): ViewSpec => ({
            from: t.r.id,
            key,
            props: {
                radiusTopLeft: at === 0 ? radius : null,
                radiusTopRight: at === 0 ? radius : null,
                radiusBottomLeft: at === 0 ? null : radius,
                radiusBottomRight: at === 0 ? null : radius,
                radius: null,
                accessibilityLabel: name,
                accessibilityId: `valenced.row.${key}`,
            },
            on: { press: () => open(key) },
            children: [
                {
                    from: t.i.id,
                    children: [
                        { from: t.icon.id, props: { uri } },
                        t.wrap
                            ? {
                                  from: t.wrap.id,
                                  children: [
                                      {
                                          from: t.label.id,
                                          props: { text: name },
                                      },
                                  ],
                              }
                            : { from: t.label.id, props: { text: name } },
                        ...(value === undefined
                            ? []
                            : [
                                  {
                                      from: t.label.id,
                                      key: `${key}.value`,
                                      props: {
                                          text: value,
                                          color:
                                              views.prop(t.arrow, 'tint') ??
                                              null,
                                          fontSize: 14,
                                          lineHeight: 18,
                                          flex: null,
                                      },
                                  },
                              ]),
                        {
                            from: t.chevron.id,
                            children: [{ from: t.arrow.id }],
                        },
                    ],
                },
            ],
        }),
    )

    screen.patch = views.insert(screen.bar, 'after', {
        from: t.s.id,
        key: 'section',
        children: [
            { from: t.h.id, props: { text: 'Valenced' } },
            {
                from: t.c.id,
                children:
                    gap && divider
                        ? [
                              rows[0],
                              {
                                  from: gap.id,
                                  key: 'divider',
                                  children: [{ from: divider.id }],
                              },
                              rows[1],
                          ]
                        : rows,
            },
        ],
    })

    screen.template = t
    const { keys } = screen.patch
    views.observe(t.arrow.id, arrow => {
        for (const id of [keys['valenced.value'], keys['plugins.value']])
            if (id !== undefined && views.node(id))
                views.setProps(id, { color: views.prop(arrow, 'tint') ?? null })
    })

    countEnabled()
    filter()
}

function filter() {
    if (!screen?.patch || screen.patch.removed) return
    for (const show of screen.hidden.splice(0)) show()

    const value = views.prop(screen.input, 'value')
    const query = value?.type === 'str' ? value.value.trim().toLowerCase() : ''
    if (!query) return

    const { keys } = screen.patch
    const misses = ['valenced', 'plugins'].filter(
        key => !`valenced ${key}`.includes(query),
    )
    if (misses.length === 2) screen.hidden.push(views.hide(screen.patch.id))
    else if (misses.length)
        for (const id of [keys[misses[0]], keys.divider])
            if (id !== undefined) screen.hidden.push(views.hide(id))
}

function open(page: string) {
    const t = (screen && template(screen.list)) ?? screen?.template
    const pageNode = views.find({ accessibilityId: 'settings-phone' })
    const logout = views.find(
        { accessibilityId: 'settings.row.logout' },
        pageNode?.id,
    )
    const field = views.node(
        views.node(screen?.input ?? -1)?.parent ?? -1,
    )?.parent
    const divider = views.find(DIVIDER, pageNode?.id)

    callNativeMethod('valenced.phoenix.openSettings', [
        {
            background: color(pageNode, 'background'),
            card: color(t?.r, 'background'),
            pressed: color(t?.r, 'activeBackground'),
            divider: color(divider, 'background'),
            text: color(t?.label, 'color'),
            muted: color(t?.h, 'color'),
            danger: color(
                views.find({ type: 'text' }, logout?.children[0] ?? -1),
                'color',
            ),
            field: color(field, 'background'),
            outline: color(field, 'borderColor'),
        },
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

views.watch({ accessibilityId: 'user_settings_search_input' }, input => {
    let bar = input
    let list = views.node(input.parent ?? -1)
    while (list && views.node(list.parent ?? -1)?.type !== 'scroll') {
        bar = list
        list = views.node(list.parent ?? -1)
    }
    if (!list) {
        nativeLoggingHook('No Valenced row, Settings layout unknown', 2)
        return
    }

    const current: Screen = {
        list: list.id,
        bar: bar.id,
        input: input.id,
        hidden: [],
    }
    screen = current
    inject()
    if (!current.patch && views.prop(input, 'value')?.type !== 'str')
        nativeLoggingHook('No Valenced row, Settings layout unknown', 2)
    const offList = views.observe(list.id, inject)
    const offInput = views.observe(input.id, filter)

    return () => {
        offList()
        offInput()
        current.patch?.remove()
        if (screen === current) screen = undefined
    }
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
