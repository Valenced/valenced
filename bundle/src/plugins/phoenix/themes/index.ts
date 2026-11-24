import { callNativeMethodSync } from '@valenced/modules/native'
import { onOps } from '@valenced/phoenix'
import { registerInternalPhoenixPlugin } from '@valenced/phoenix/plugins'
import { findColors, propKey } from '@valenced/phoenix/ui'
import tokens from './tokens.json'

interface ThemeColors {
    semantic?: Partial<Record<string, Record<string, string>>>
    raw?: Record<string, string>
}

const BASES = ['dark', 'darker', 'light', 'midnight']

enum Role {
    Text = 1,
    Icon,
    Border,
    Background,
    Any,
}

const PROP_ROLES: Record<string, Role> = {
    color: Role.Text,
    placeholderColor: Role.Text,
    selectionColor: Role.Text,
    handleColor: Role.Text,
    tint: Role.Icon,
    thumbTint: Role.Icon,
    minTrackTint: Role.Icon,
    maxTrackTint: Role.Icon,
    borderColor: Role.Border,
    activeBorderColor: Role.Border,
    focusBorderColor: Role.Border,
    bgBorder: Role.Border,
    background: Role.Background,
    activeBackground: Role.Background,
    backgroundGradient: Role.Background,
    activeBackgroundGradient: Role.Background,
    bg: Role.Background,
    blur: Role.Background,
    scrimColor: Role.Background,
    navScrimColor: Role.Background,
    loadingBackground: Role.Background,
    shadow: Role.Any,
    activeShadow: Role.Any,
    textShadow: Role.Any,
    bgShadow: Role.Any,
    elevationColor: Role.Any,
    fill: Role.Any,
    stroke: Role.Any,
    worklet: Role.Background,
    viewMotion: Role.Background,
}

const PREFERRED: Record<Role, Role[]> = {
    [Role.Text]: [Role.Text, Role.Icon],
    [Role.Icon]: [Role.Icon, Role.Text],
    [Role.Border]: [Role.Border],
    [Role.Background]: [Role.Background],
    [Role.Any]: [],
}

const raws = Object.entries(tokens.raw)

const unique = new Map<number, number>()
const shared = new Set<number>()
for (const [index] of BASES.entries())
    for (const definitions of Object.values(tokens.semantic)) {
        const color = resolve(definitions.split(' ')[index]!)
        if (!color || shared.has(color)) continue
        const base = unique.get(color)
        if (base === undefined) unique.set(color, index)
        else if (base !== index) {
            unique.delete(color)
            shared.add(color)
        }
    }

let roles: number[] | undefined
let maps: Map<number, number>[][] | undefined
let base: number | undefined

export function themed(color: number | undefined, prop: string) {
    if (color === undefined || base === undefined) return color
    return maps?.[base]?.[PROP_ROLES[prop] ?? Role.Any]?.get(color) ?? color
}

function parse(hex: string | undefined) {
    if (!hex || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return
    let digits = hex.slice(1)
    if (digits.length === 3) digits = digits.replace(/./g, '$&$&')
    const alpha = digits.length === 8 ? digits.slice(6) : 'ff'
    return Number.parseInt(alpha + digits.slice(0, 6), 16) >>> 0
}

function resolve(definition: string, raw?: Record<string, string>) {
    const [index, alpha] = definition.split('/')
    const [name, hex] = raws[Number(index)]!
    const color = parse(raw?.[name]) ?? parse(hex)
    if (color === undefined || alpha === undefined) return color
    return ((Number(alpha) << 24) | (color & 0xffffff)) >>> 0
}

registerInternalPhoenixPlugin('valenced.api.themes', {
    start({ cleanup, logger }) {
        let values: ThemeColors | undefined
        try {
            values = JSON.parse(
                callNativeMethodSync(
                    'valenced.themes.getState' as never,
                    [] as never,
                ),
            ).colors?.values
        } catch (e) {
            logger.warn(`Unable to read the theme: ${e}`)
        }
        if (!values) return

        if (!roles) {
            roles = []
            for (const [name, role] of Object.entries(PROP_ROLES)) {
                const key = propKey(name)
                if (key !== undefined) roles[key] = role
            }
        }

        // A Discord color shared by several tokens takes the theme color most changed tokens agree on
        maps = BASES.map((name, index) => {
            const votes = new Map<number, Map<Role, Map<number, number>>>()
            for (const [token, definitions] of Object.entries(
                tokens.semantic,
            )) {
                const definition = definitions.split(' ')[index]!
                const discord = resolve(definition)
                if (!discord) continue
                const theme =
                    parse(values.semantic?.[name]?.[token]) ??
                    resolve(definition, values.raw)!
                const role = token.includes('TEXT')
                    ? Role.Text
                    : token.includes('ICON')
                      ? Role.Icon
                      : token.includes('BORDER')
                        ? Role.Border
                        : /BACKGROUND|(?:^|_)BG(?:_|$)|SURFACE|SCRIM/.test(
                                token,
                            )
                          ? Role.Background
                          : Role.Any

                let byRole = votes.get(discord)
                if (!byRole) votes.set(discord, (byRole = new Map()))
                let counts = byRole.get(role)
                if (!counts) byRole.set(role, (counts = new Map()))
                counts.set(theme, (counts.get(theme) ?? 0) + 1)
            }

            const byProp: Map<number, number>[] = []
            for (const role of Object.keys(PREFERRED).map(Number) as Role[]) {
                const map = (byProp[role] = new Map())
                for (const [discord, byRole] of votes) {
                    const preferred = PREFERRED[role].find(it => byRole.has(it))
                    const counts = new Map<number, number>()
                    let best: number | undefined
                    for (const [tokenRole, theme] of byRole)
                        if (preferred === undefined || tokenRole === preferred)
                            for (const [color, count] of theme) {
                                if (color === discord) continue
                                const total = (counts.get(color) ?? 0) + count
                                counts.set(color, total)
                                if (
                                    best === undefined ||
                                    total > counts.get(best)!
                                )
                                    best = color
                            }
                    if (best !== undefined) map.set(discord, best)
                }
            }
            return byProp
        })
        base = undefined

        cleanup(
            () => {
                maps = undefined
                base = undefined
            },
            onOps(bytes => {
                let found: number[]
                try {
                    found = findColors(bytes, roles!)
                } catch (e) {
                    logger.warn(`Skipped a batch: ${e}`)
                    return
                }

                // Phoenix sends resolved colors only, so the base shows in colors unique to it
                const scores = [0, 0, 0, 0]
                for (let i = 2; i < found.length; i += 3) {
                    const index = unique.get(found[i]!)
                    if (index !== undefined) scores[index]!++
                }
                const best = scores.indexOf(Math.max(...scores))
                if (scores[best]! > (base === undefined ? 0 : scores[base]!))
                    base = best
                if (base === undefined) return

                const current = maps![base]!
                let out: DataView | undefined
                for (let i = 0; i < found.length; i += 3) {
                    const color = found[i + 2]!
                    if (!color) continue
                    const next = current[found[i + 1]!]!.get(color)
                    if (next === undefined) continue
                    out ??= new DataView(bytes.slice().buffer)
                    out.setUint32(found[i]!, next, true)
                }
                return out && new Uint8Array(out.buffer)
            }),
        )
    },
})
