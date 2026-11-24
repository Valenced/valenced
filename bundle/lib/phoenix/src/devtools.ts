import {
    callNativeMethod,
    callNativeMethodSync,
    registerJSMethod,
} from '@valenced/modules/native'
import { reloadApp } from '@valenced/modules/native/app'
import { getErrorStack } from '@valenced/utils/error'
import { FullVersion } from '~constants'
import * as bytes from './bytes'
import * as phoenix from './index'
import { phoenixApi } from './plugins'
import * as ui from './ui'
import { createViews, find, findAll, node } from './views'
import type { ViewQuery, Views } from './views'

// Revenge DevTools protocol, devalue encoded on the wire
const Hello = 1
const Hi = 2
const Log = 3
const Run = 4
const MCPRun = 5
const MCPResult = 6
const ProtocolVersion = 5

const SOCKET_MESSAGE = 0x17a
const MAX_EVENTS = 200
const MAX_EVENT_BYTES = 0x10000
const MAX_LOGS = 1000

interface GatewayEvent {
    time: number
    t: string | null
    op: number
    s: number | null
    size: number
    text: string
}

const logs: Array<{ level: number; time: number; message: unknown[] }> = []
const events: GatewayEvent[] = []
let settings = { log: { level: 1, inspectDepth: 2 } }
let scope: Record<string, unknown> | undefined
let views: Views | undefined
let offDispatch: (() => void) | undefined
let logHook: typeof nativeLoggingHook | undefined

registerJSMethod('valenced.devtools.open', () => {
    views = createViews()
    scope = {
        vars: { mcp: {} },
        phoenix: { ...phoenixApi, views },
        views,
        tree,
        events: recentEvents,
        callNativeMethod,
        callNativeMethodSync,
    }

    logHook = nativeLoggingHook
    globalThis.nativeLoggingHook = (message, level) => {
        logHook!(message, level)
        log(level, [message])
    }

    offDispatch = phoenix.onDispatch((_, frame) => {
        for (const event of ui.splitDispatch(frame)) {
            const view = new DataView(event.buffer, event.byteOffset)
            if (
                event.length < 16 ||
                view.getUint32(0, true) !== 3 ||
                view.getUint32(4, true) !== SOCKET_MESSAGE
            )
                continue

            const body = event.subarray(16 + view.getUint32(12, true))
            const text = bytes.decodeUtf8(body.subarray(0, MAX_EVENT_BYTES))
            const head = /"t":(?:"(\w+)"|null),"s":(\d+|null),"op":(\d+)/.exec(
                text,
            )
            events.push({
                time: Date.now(),
                t: head?.[1] ?? null,
                op: Number(head?.[3] ?? -1),
                s: head?.[2] && head[2] !== 'null' ? Number(head[2]) : null,
                size: body.length,
                text,
            })
            if (events.length > MAX_EVENTS) events.shift()
        }
    })

    send(Hello, {
        version: ProtocolVersion,
        info: `Valenced ${FullVersion} (Phoenix)`,
        alias: 'phoenix',
    })
})

registerJSMethod('valenced.devtools.close', () => {
    if (logHook) globalThis.nativeLoggingHook = logHook
    logHook = undefined
    offDispatch?.()
    offDispatch = undefined
    views?.dispose()
    views = scope = undefined
    events.length = 0
})

registerJSMethod('valenced.devtools.message', (text: string) => {
    const { type, data } = decode(text) as { type: number; data: any }
    if (type === Hi) {
        if (data.supported) settings = data.settings
        else nativeLoggingHook('The DevTools server rejected this client', 2)
    } else if (type === Run) run(data.code, data.mappings ?? {})
    else if (type === MCPRun) mcp(data.id, data.command, data.args ?? {})
})

function tree(root?: number | ViewQuery, depth = 12) {
    const start = typeof root === 'object' ? find(root)?.id : root
    const roots =
        start === undefined
            ? findAll({})
                  .filter(it => it.parent === undefined && it.children.length)
                  .map(it => it.id)
            : [start]

    const lines: string[] = []
    const visit = (id: number, level: number) => {
        const it = node(id)
        if (!it) return

        const props = it.props.flatMap(({ key, value }) => {
            const name = ui.propName(key) ?? key
            if (value.type === 'str')
                return `${name}=${JSON.stringify(value.value.slice(0, 80))}`
            if (
                value.type === 'arr' &&
                value.value.every(v => v.type === 'str')
            )
                return `${name}=[${value.value.map(v => v.value).join(',')}]`
            return []
        })
        const more =
            level === depth && it.children.length
                ? ` (+${it.children.length})`
                : ''
        lines.push(
            `${'  '.repeat(level)}${it.type} #${id}${props.length ? ` ${props.join(' ')}` : ''}${more}`,
        )
        if (level < depth)
            for (const child of it.children) visit(child, level + 1)
    }
    for (const id of roots) visit(id, 0)
    return lines.join('\n')
}

function recentEvents(limit = 20, type?: string) {
    return events
        .filter(it => type === undefined || it.t === type)
        .slice(-limit)
        .map(({ text, ...it }) => {
            if (it.size > MAX_EVENT_BYTES) return { ...it, d: text }
            try {
                return { ...it, d: JSON.parse(text).d }
            } catch {
                return { ...it, d: text }
            }
        })
}

async function run(code: string, mappings: Record<string, string>) {
    try {
        const values = { ...scope }
        for (const [key, path] of Object.entries(mappings))
            try {
                values[key] = evaluate(path)
            } catch {}
        log(1, [await evaluate(code, values)])
    } catch (e) {
        log(3, [format(e)])
    }
}

async function mcp(id: string, command: string, args: Record<string, any>) {
    const depth = args.depth ?? settings.log.inspectDepth
    try {
        let result: unknown
        switch (command) {
            case 'eval':
                result = snapshot(await evaluate(args.code), depth)
                break
            case 'save_var': {
                const value = evaluate(args.expression)
                ;(scope!.vars as Record<string, unknown>)[args.name] = value
                result = { name: args.name, value: snapshot(value, depth) }
                break
            }
            case 'get_logs': {
                const found = logs
                    .filter(it => it.level >= (args.min_level ?? 0))
                    .slice(-(args.limit ?? MAX_LOGS))
                result = {
                    count: found.length,
                    logs: found.map(it => ({
                        ...it,
                        message: it.message.map(m => snapshot(m, depth)),
                    })),
                }
                break
            }
            case 'discord_reload':
                setTimeout(reloadApp, 0)
                result = { reloading: true }
                break
            default:
                throw new Error(
                    `${command} is not available in Phoenix. Use eval with tree(), events() and views.`,
                )
        }
        send(MCPResult, { id, ok: true, result })
    } catch (e) {
        send(MCPResult, { id, ok: false, error: format(e) })
    }
}

function evaluate(code: string, values = scope!) {
    let error: unknown
    for (const body of [`return (${code}\n)`, code]) {
        let fn: (...args: unknown[]) => unknown
        try {
            fn = new Function(...Object.keys(values), body) as typeof fn
        } catch (e) {
            error = e
            continue
        }
        return fn(...Object.values(values))
    }
    throw error
}

function log(level: number, message: unknown[]) {
    const entry = {
        level,
        time: Date.now(),
        message: message.map(it => snapshot(it, settings.log.inspectDepth)),
    }
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    if (level >= settings.log.level)
        send(Log, { level, message: entry.message })
}

function send(type: number, data: unknown) {
    try {
        callNativeMethodSync('valenced.devtools.send', [encode({ type, data })])
    } catch {}
}

function format(e: unknown) {
    return e instanceof Error ? `${e}\n${getErrorStack(e)}` : String(e)
}

function snapshot(value: unknown, depth: number, path = new Set<object>()) {
    if (typeof value === 'function')
        return `[Function: ${value.name || 'anonymous'}]`
    if (typeof value === 'bigint' || typeof value === 'symbol')
        return String(value)
    if (!value || typeof value !== 'object') return value
    if (value instanceof Error) return format(value)
    if (value instanceof Date || value instanceof RegExp) return String(value)
    if (ArrayBuffer.isView(value))
        return `[${value.constructor.name}(${value.byteLength})]`
    if (path.has(value)) return '[Circular]'

    const list =
        value instanceof Map || value instanceof Set
            ? [...value]
            : Array.isArray(value)
              ? value
              : undefined
    const keys = list ? [] : Object.keys(value)
    if (depth <= 0)
        return list
            ? `[${value.constructor.name}(${list.length})]`
            : `[Object {${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', ...' : ''}}]`

    path.add(value)
    const out: unknown = list
        ? list.map(it => snapshot(it, depth - 1, path))
        : Object.fromEntries(
              keys.map(key => {
                  try {
                      return [
                          key,
                          snapshot(
                              (value as Record<string, unknown>)[key],
                              depth - 1,
                              path,
                          ),
                      ]
                  } catch (e) {
                      return [key, `[Throws: ${e}]`]
                  }
              }),
          )
    path.delete(value)
    return out
}

function encode(value: unknown) {
    const out: string[] = []
    const flatten = (it: unknown): number => {
        if (it === undefined) return -1
        if (typeof it === 'number' && !Number.isFinite(it))
            return Number.isNaN(it) ? -3 : it > 0 ? -4 : -5

        const at = out.push('') - 1
        out[at] = Array.isArray(it)
            ? `[${it.map(flatten)}]`
            : it && typeof it === 'object'
              ? `{${Object.entries(it).map(([k, v]) => `${JSON.stringify(k)}:${flatten(v)}`)}}`
              : JSON.stringify(it)
        return at
    }

    const root = flatten(value)
    return root < 0 ? String(root) : `[${out}]`
}

function decode(text: string) {
    const values = JSON.parse(text)
    const hydrate = (at: number): unknown => {
        if (at < 0)
            return [0, undefined, undefined, NaN, Infinity, -Infinity, -0][-at]
        const it = values[at]
        if (!it || typeof it !== 'object') return it
        if (Array.isArray(it))
            return typeof it[0] === 'string' ? undefined : it.map(hydrate)
        return Object.fromEntries(
            Object.entries(it).map(([k, v]) => [k, hydrate(v as number)]),
        )
    }
    return typeof values === 'number' ? hydrate(values) : hydrate(0)
}

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.devtools.send': [[message: string], null]
    }
}
