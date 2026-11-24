import watcher from '@parcel/watcher'
import { debounce } from '@valenced/utils/callback'
import chalk from 'chalk'
import { readFile } from 'fs/promises'
import { createServer } from 'http'
import os from 'os'
import { join } from 'path'
import { crc32 } from 'zlib'
import pkg from '../package.json' with { type: 'json' }
import build from './build'

const prod = process.argv.includes('--prod')
const lanHost = process.argv.includes('--lan')
const PortArg = process.argv.indexOf('--port')

const Port = PortArg === -1 ? 4040 : Number(process.argv[PortArg + 1])
const BundlePath = './dist/valenced.bundle'
const BundleManifestPath = './dist/manifest.json'
const PhoenixBundlePath = './dist/phoenix/valenced.phoenix.bundle'

console.info(chalk.redBright(`\nValenced ${chalk.white(`v${pkg.version}`)}\n`))

const cwdify = (path: string) => join(process.cwd(), path)
const Sources = [
    'src',
    'lib',
    'plugins',
    'shims',
    'package.json',
    'tsconfig.json',
].map(cwdify)
const ExitTriggers = ['scripts'].map(cwdify)

const debouncedBuild = {
    rn: debounce(() => ((needRebuild.rn = false), build(!prod)), 250),
    phoenix: debounce(
        () => ((needRebuild.phoenix = false), build(!prod, true, 'phoenix')),
        250,
    ),
}

const needRebuild = { rn: true, phoenix: true }

watcher.subscribe(process.cwd(), (err, events) => {
    if (err) return console.error(err)

    if (events.some(it => ExitTriggers.some(se => it.path.startsWith(se)))) {
        console.error(chalk.redBright('\u26A0 Scripts has changed, exiting!'))
        process.exit()
    }

    if (events.some(it => Sources.some(src => it.path.startsWith(src))))
        needRebuild.rn = needRebuild.phoenix = true
})

const server = createServer(async (req, res) => {
    try {
        const path = req.url?.split('?')[0]

        let file: string
        let friendlyName: string
        let target: 'rn' | 'phoenix' = 'rn'
        if (path === '/manifest.json') {
            file = BundleManifestPath
            friendlyName = 'manifest'
        } else if (path === '/valenced.bundle') {
            file = BundlePath
            friendlyName = 'bundle'
        } else if (path === '/valenced.phoenix.bundle') {
            file = PhoenixBundlePath
            friendlyName = 'Phoenix bundle'
            target = 'phoenix'
        } else {
            res.writeHead(404)
            res.end('Not found')
            return
        }

        console.debug(
            chalk.gray(
                `\u{1F79B} Receiving request for ${friendlyName} from ${req.socket.remoteAddress}`,
            ),
        )

        if (needRebuild[target]) await debouncedBuild[target]()

        const contents = await readFile(file).catch(() => null)
        if (!contents)
            throw new Error(`Could not serve ${friendlyName}! No file found.`)

        const hash = crc32(contents).toString(16)

        if (req.headers['if-none-match'] === hash) {
            console.debug(
                chalk.gray(
                    `\u{1F4BE} ETag matched for ${friendlyName}, responding with 304`,
                ),
            )

            res.writeHead(304)
            res.end()
            return
        }

        res.writeHead(200, {
            ETag: hash,
            'Content-Length': contents.byteLength,
        })
        res.end(contents)
    } catch (e) {
        console.error(e)

        res.writeHead(500)
        res.end('Build failed. Check console for details.')
    }
})

server.listen(Port, lanHost ? '0.0.0.0' : '127.0.0.1')

if (lanHost) console.info(chalk.gray('\u24D8 Listening on all interfaces...'))
else
    console.info(
        chalk.gray(
            '\u24D8 Listening locally... Use --lan to listen on all interfaces',
        ),
    )

if (!prod) console.info(chalk.gray('\u24D8 Use --prod to build for production'))
else console.info(chalk.gray('\u24D8 Building for production...'))

console.info(chalk.cyanBright(`\u24D8 Serving on port ${Port}`))
console.info(chalk.gray('\u24D8 Accessible on:'))

for (const int of Object.values(os.networkInterfaces()))
    if (int)
        for (const det of int) {
            if (det.family !== 'IPv4' || (!det.internal && !lanHost)) continue
            console.info(chalk.gray(`- http://${det.address}:${Port}`))
        }
