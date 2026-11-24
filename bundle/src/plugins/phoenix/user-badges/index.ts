import { callNativeMethod } from '@valenced/modules/native'
import { registerInternalPhoenixPlugin } from '@valenced/phoenix/plugins'
import ValencedIcon from '../../../assets/ValencedIcon.webp'
import Data from '../../start/user-badges/data.json'
import manifest from '../../start/user-badges/manifest.json'
import type { ViewNode, ViewQuery } from '@valenced/phoenix/views'

interface Badge {
    label: string
    description: string
    icon: string
    bnw?: boolean
    showDialog?: boolean
}

const Badges: Record<string, Badge> = {
    valenced_team: {
        label: 'Valenced Team',
        description: 'This user is a Valenced team member.',
        icon: ValencedIcon,
        bnw: true,
        showDialog: true,
    },
}

const UsersWithBadges = Data as Record<string, string[]>
const BADGE_ICON = /^https:\/\/cdn\.discordapp\.com\/badge-icons\//
const USER_ID = /\/(?:users|avatars|banners)\/(\d+)\//

registerInternalPhoenixPlugin(manifest.id, {
    start({ phoenix: { views } }) {
        const uri = (node: ViewNode | undefined) => {
            const value = node && views.prop(node, 'uri')
            return value?.type === 'str' ? value.value : ''
        }
        const color = (node: ViewNode | undefined, name: string) => {
            const value = node && views.prop(node, name)
            if (value?.type === 'i64') return Number(value.value)
            if (value?.type === 'i32') return value.value >>> 0
        }
        const isBadge = (id: number) =>
            BADGE_ICON.test(uri(views.node(views.node(id)?.children[0] ?? -1)))
        const avatar: ViewQuery = {
            type: 'image',
            where: it => USER_ID.test(uri(it)),
        }

        views.watch(
            { type: 'view', where: it => it.children.some(isBadge) },
            row => {
                // The profile header comes before the badges, mutual friends after
                let found: ViewNode | undefined
                for (
                    let child = row, parent = views.node(row.parent ?? -1);
                    parent && !found && child.type !== 'scroll';
                    child = parent, parent = views.node(parent.parent ?? -1)
                )
                    for (const id of parent.children.slice(
                        0,
                        parent.children.indexOf(child.id),
                    ))
                        found ??= views.find(avatar, id)

                const userId = USER_ID.exec(uri(found))?.[1]
                const badges = (UsersWithBadges[userId ?? ''] ?? []).flatMap(
                    id => Badges[id] ?? [],
                )
                if (!badges.length) return

                const template = views.node(
                    row.children.filter(isBadge).at(-1)!,
                )!

                let flow = views.node(row.parent ?? -1)
                while (flow && flow.type !== 'flow')
                    flow = views.node(flow.parent ?? -1)
                const text = flow && views.find({ type: 'text' }, flow.id)
                const last = views.node(row.children.at(-1)!)
                let sheet = views.node(row.parent ?? -1)
                while (sheet && color(sheet, 'background') === undefined)
                    sheet = views.node(sheet.parent ?? -1)

                const patches = badges.map(badge =>
                    views.insert(
                        last?.type === 'text' ? last.id : row.id,
                        last?.type === 'text' ? 'before' : 'end',
                        {
                            from: template.id,
                            props: {
                                role: badge.showDialog ? 'button' : null,
                                accessibilityLabel: `Badge, ${badge.label}`,
                            },
                            on: badge.showDialog
                                ? {
                                      press: () => {
                                          callNativeMethod(
                                              'valenced.phoenix.showBadge',
                                              [
                                                  {
                                                      background: color(
                                                          sheet,
                                                          'background',
                                                      ),
                                                      card: color(
                                                          row,
                                                          'background',
                                                      ),
                                                      text: color(
                                                          text,
                                                          'color',
                                                      ),
                                                  },
                                                  {
                                                      icon: badge.icon,
                                                      label: badge.label,
                                                      description:
                                                          badge.description,
                                                      tint: badge.bnw === true,
                                                  },
                                              ],
                                          )
                                      },
                                  }
                                : undefined,
                            children: [
                                {
                                    from: template.children[0],
                                    props: {
                                        uri: badge.icon,
                                        tint:
                                            (badge.bnw &&
                                                text &&
                                                views.prop(text, 'color')) ||
                                            null,
                                    },
                                },
                            ],
                        },
                    ),
                )

                return () => {
                    for (const patch of patches) patch.remove()
                }
            },
        )
    },
})

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.phoenix.showBadge': [
            [
                Record<string, number | undefined>,
                Record<string, string | boolean>,
            ],
            null,
        ]
    }
}
