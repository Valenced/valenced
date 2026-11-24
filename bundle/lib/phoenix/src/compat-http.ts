import { decodeUtf8, encodeUtf8 } from './bytes'
import { URLSearchParams } from './fetch'
import { dispatchLocalFlux } from './flux'
import { onRequest, request, resend, respond, watch } from './http'
import type { HttpRequest, HttpResponse } from './http'

const API =
    /^(https:\/\/(?:\w+\.)?discord\.com\/api(?:\/v\d+)?)(\/[^?]*)(?:\?(.*))?$/
const Guest = Symbol('valenced.phoenix.guestRequest')

interface Route {
    method: string
    path: string
    query?: Record<string, unknown>
    body?: unknown
}

type Pass = (route: Route) => Promise<unknown>

let syncPass: Pass | undefined

function toResponse({ status, headers, body }: HttpResponse) {
    const text = decodeUtf8(body)
    let parsed: unknown = text
    try {
        parsed = text ? JSON.parse(text) : undefined
    } catch {}
    return {
        ok: status >= 200 && status < 300,
        status,
        headers,
        body: parsed,
        text,
    }
}

function toUrl(base: string, { path, query }: Route) {
    const search = new URLSearchParams(
        Object.entries(query ?? {})
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
    ).toString()
    return `${base}${path.startsWith('/') ? '' : '/'}${path}${search ? `?${search}` : ''}`
}

/** Fake module function. Answers Phoenix's request when it intercepts one, or sends its own. */
function facade(carrier: number, route: (args: any[]) => Route) {
    return (...args: any[]) => {
        const target = route(args)
        const pass: Pass | undefined = args[carrier]?.[Guest] ?? syncPass
        if (pass) return pass(target)

        return request({
            method: target.method,
            url: toUrl('https://discord.com/api/v9', target),
            headers:
                target.body === undefined
                    ? {}
                    : { 'content-type': 'application/json' },
            body:
                target.body === undefined
                    ? undefined
                    : JSON.stringify(target.body),
        }).then(response => {
            const result = toResponse(response)
            if (!result.ok) throw result
            return result
        })
    }
}

const http = (method: string) =>
    facade(0, ([options]) => ({
        method,
        path: typeof options === 'string' ? options : (options?.url ?? ''),
        query: options?.query,
        body: options?.body,
    }))

const HTTP = {
    get: http('GET'),
    post: http('POST'),
    put: http('PUT'),
    patch: http('PATCH'),
    del: http('DELETE'),
}

const Messages = {
    sendMessage: facade(1, ([channelId, message]) => ({
        method: 'POST',
        path: `/channels/${channelId}/messages`,
        body: message,
    })),
    editMessage: facade(2, ([channelId, messageId, message]) => ({
        method: 'PATCH',
        path: `/channels/${channelId}/messages/${messageId}`,
        body: message,
    })),
    receiveMessage: () => {},
}

const Uploads = {
    uploadLocalFiles: facade(0, ([{ channelId, items }]) => ({
        method: 'POST',
        path: `/channels/${channelId}/attachments`,
        body: { files: items },
    })),
}

const Invites = {
    acceptInvite: facade(0, ([{ inviteKey }]) => ({
        method: 'POST',
        path: `/invites/${inviteKey}`,
    })),
    acceptInviteAndTransitionToInviteChannel: (options: {
        inviteKey: string
    }) => Invites.acceptInvite(options),
}

const GuildNotificationSettings = {
    updateGuildNotificationSettings: facade(-1, ([guildId, settings]) => ({
        method: 'PATCH',
        path: `/users/@me/guilds/${guildId}/settings`,
        body: settings,
    })),
}

/** Fake Discord modules, by the first prop or name a module filter looks for. */
export const httpShims: Record<string, unknown> = {
    HTTP: { HTTP },
    sendMessage: Messages,
    editMessage: Messages,
    Messages: { default: Messages },
    uploadLocalFiles: Uploads,
    acceptInvite: Invites,
    updateGuildNotificationSettings: GuildNotificationSettings,
}

// Unpatched functions, as patches replace the properties
const bases = { ...HTTP }
const routes: Array<
    [
        module: Record<string, any>,
        name: string,
        method: string,
        path: RegExp,
        args: (match: RegExpMatchArray, body: any) => unknown[],
    ]
> = [
    [
        Messages,
        'sendMessage',
        'POST',
        /^\/channels\/(\d+)\/messages$/,
        ([, channelId], body) => [channelId, body],
    ],
    [
        Messages,
        'editMessage',
        'PATCH',
        /^\/channels\/(\d+)\/messages\/(\d+)$/,
        ([, channelId, messageId], body) => [channelId, messageId, body],
    ],
    [
        Uploads,
        'uploadLocalFiles',
        'POST',
        /^\/channels\/(\d+)\/attachments$/,
        ([, channelId], body) => [{ channelId, items: body?.files ?? [] }],
    ],
    [
        Invites,
        'acceptInvite',
        'POST',
        /^\/invites\/([^/]+)$/,
        ([, inviteKey]) => [{ inviteKey }],
    ],
]
const routeBases = routes.map(([module, name]) => module[name])

// New names of renamed uploads, by original name, for the message that sends them
const renamed = new Map<string, string>()
let attached = 0
let detach: (() => void) | undefined

/** Runs fake module patches for matching Phoenix requests. Returns a detach function. */
export function attachHttp() {
    if (!attached++) detach = onRequest(onGuestRequest)

    let released = false
    return () => {
        if (released) return
        released = true
        if (--attached) return
        detach?.()
        renamed.clear()
    }
}

function onGuestRequest(guest: HttpRequest) {
    const match = API.exec(guest.url)
    if (!match) return
    const [, prefix, path] = match as unknown as [string, string, string]
    let body: any
    if (guest.body[0] === 0x7b || guest.body[0] === 0x5b)
        try {
            body = JSON.parse(decodeUtf8(guest.body))
        } catch {}

    if (guest.method === 'POST' && /^\/channels\/\d+\/typing$/.test(path)) {
        if (
            dispatchLocalFlux({
                type: 'TYPING_START_LOCAL',
                channelId: path.split('/')[2],
            })
        )
            return
        respond(guest.id, 204)
        return false
    }

    let request = guest
    if (Array.isArray(body?.attachments) && renamed.size) {
        for (const attachment of body.attachments)
            if (renamed.has(attachment.filename))
                attachment.filename = renamed.get(attachment.filename)
        renamed.clear()
        request = { ...guest, body: encodeUtf8(JSON.stringify(body)) }
    }

    const toGuest = (route: Route): HttpRequest => ({
        ...request,
        method: route.method,
        url: toUrl(prefix, route),
        body:
            route.body === undefined
                ? request.body
                : encodeUtf8(JSON.stringify(route.body)),
    })

    for (const [i, [module, name, method, pattern, args]] of routes.entries()) {
        const found = guest.method === method && path.match(pattern)
        if (!found || module[name] === routeBases[i]) continue

        const files: Array<{ filename: string }> =
            name === 'uploadLocalFiles' ? (body?.files ?? []) : []
        const names = files.map(file => file.filename)
        const result = intercept(
            request,
            module[name],
            args(found, body),
            toGuest,
        )
        files.forEach((file, j) => {
            if (file.filename !== names[j])
                renamed.set(names[j]!, file.filename)
        })
        return result
    }

    const name = (
        guest.method === 'DELETE' ? 'del' : guest.method.toLowerCase()
    ) as keyof typeof HTTP
    if (!bases[name] || HTTP[name] === bases[name])
        return request === guest ? undefined : request

    const [, , , search] = match
    return intercept(
        request,
        HTTP[name],
        [
            {
                url: path,
                query: search
                    ? Object.fromEntries(new URLSearchParams(search).entries())
                    : undefined,
                body,
            },
        ],
        toGuest,
    )
}

/**
 * Calls a patched fake module with Phoenix's request. A synchronous call through to the original
 * sends the request on, a later one sends it again. A patch answering on its own fakes the reply.
 */
function intercept(
    guest: HttpRequest,
    patched: (...args: unknown[]) => unknown,
    args: unknown[],
    toGuest: (route: Route) => HttpRequest,
): HttpRequest | false | undefined {
    let reply!: (response: HttpResponse) => void
    const replied = new Promise<HttpResponse>(resolve => {
        reply = resolve
    }).then(response => {
        const result = toResponse(response)
        if (!result.ok) throw result
        return result
    })
    replied.catch(() => {})

    let passed: HttpRequest | undefined
    let sync = true
    let resent = false
    const pass: Pass = route => {
        if (sync) passed = toGuest(route)
        else if (!resent) {
            resent = true
            watch(guest.id, reply)
            resend(toGuest(route)).catch(() => respond(guest.id, 502))
        }
        return replied
    }

    const carrier = args.find(arg => arg && typeof arg === 'object')
    if (carrier)
        Object.defineProperty(carrier, Guest, {
            value: pass,
            configurable: true,
        })

    let result: unknown
    syncPass = pass
    try {
        result = patched(...args)
    } catch {
        result = undefined
        passed ??= guest
    } finally {
        syncPass = undefined
        sync = false
    }

    if (passed) {
        watch(guest.id, reply)
        return passed
    }

    if (typeof (result as Promise<unknown> | undefined)?.then === 'function') {
        ;(
            result as Promise<{ status?: number; body?: unknown } | undefined>
        ).then(
            value => {
                if (resent) return
                respond(
                    guest.id,
                    value?.status ?? (value?.body === undefined ? 204 : 200),
                    value?.body === undefined ? '' : JSON.stringify(value.body),
                )
            },
            () => {
                if (!resent) resend(guest).catch(() => respond(guest.id, 502))
            },
        )
        return false
    }

    respond(guest.id, 204)
    return false
}
