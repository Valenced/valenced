package app.valenced.xposed.tweaks.bridge

import android.util.Base64
import app.valenced.bridge.asDelegate
import app.valenced.reloadApp
import app.valenced.xposed.api.registerNativeAsyncMethod
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.openFileGuarded
import app.valenced.xposed.tweak
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.http.content.*
import java.io.File

private val discordHosts = listOf("discord.com", "discordapp.com", "discord.gg")
private val redirectStatuses = setOf(301, 302, 303, 307, 308)

// Redirects are followed by hand, so every hop goes through the Discord host check.
private val fetchClient by lazy {
    HttpClient(CIO) {
        expectSuccess = false
        followRedirects = false
    }
}

/**
 * `valenced.fs.*` + `valenced.app.*` + `valenced.http.fetch` bridge methods.
 */
val additionalBridgeMethods by tweak {
    registerNativeMethod("valenced.app.reload") {
        reloadApp()
    }

    registerNativeAsyncMethod("valenced.http.fetch") { args ->
        var url = Url(args[0] as String)
        var method = HttpMethod.parse((args[1] as String).uppercase())
        val headers = (args[2] as List<*>).map { it as List<*> }
        var body = (args[3] as String?)?.let { Base64.decode(it, Base64.NO_WRAP) }
        val contentType = headers.lastOrNull { HttpHeaders.ContentType.equals(it[0] as String, true) }
            ?.let { ContentType.parse(it[1] as String) } ?: ContentType.Application.OctetStream

        var redirects = 0
        var response: HttpResponse
        while (true) {
            if (url.protocol != URLProtocol.HTTPS && url.protocol != URLProtocol.HTTP)
                throw Error("Only http and https URLs can be fetched: $url")
            if (discordHosts.any { url.host == it || url.host.endsWith(".$it") })
                throw Error("Requests to ${url.host} are not allowed")

            response = fetchClient.request(url) {
                this.method = method
                for ((name, value) in headers) {
                    if (HttpHeaders.ContentType.equals(name as String, true)) continue
                    if (HttpHeaders.ContentLength.equals(name, true)) continue
                    this.headers.append(name, value as String)
                }
                body?.let { setBody(ByteArrayContent(it, contentType)) }
            }

            val location = response.headers[HttpHeaders.Location]
            if (response.status.value !in redirectStatuses || location == null || ++redirects > 20) break
            url = URLBuilder(url).takeFrom(location).build()
            if (response.status.value == 303 || response.status.value < 307 && method == HttpMethod.Post) {
                method = HttpMethod.Get
                body = null
            }
        }

        mapOf(
            "status" to response.status.value,
            "statusText" to response.status.description,
            "url" to url.toString(),
            "redirected" to (redirects > 0),
            "headers" to response.headers.entries().flatMap { (name, values) -> values.map { listOf(name, it) } },
            "body" to Base64.encodeToString(response.bodyAsBytes(), Base64.NO_WRAP),
        )
    }

    withAppContext { ctx ->
        registerNativeMethod("valenced.fs.getConstants") {
            mapOf(
                "data" to ctx.dataDir.absolutePath,
                "files" to ctx.filesDir.absolutePath,
                "cache" to ctx.cacheDir.absolutePath,
            )
        }

        registerNativeMethod("valenced.fs.delete") { args ->
            val argv = args.asDelegate()
            val path by argv.string()
            val f = File(path)
            if (f.isDirectory) f.deleteRecursively() else f.delete()
        }

        registerNativeMethod("valenced.fs.exists") { args ->
            val argv = args.asDelegate()
            val path by argv.string()
            File(path).exists()
        }

        registerNativeMethod("valenced.fs.read") { args ->
            val argv = args.asDelegate()
            val path by argv.string()
            val file = File(path).also { it.openFileGuarded() }
            file.bufferedReader().use { it.readText() }
        }

        registerNativeMethod("valenced.fs.write") { args ->
            val argv = args.asDelegate()
            val path by argv.string()
            val contents by argv.string()
            File(path).apply {
                if (isDirectory) throw Error("Path is a directory: $path")
                parentFile?.mkdirs()
                writeText(contents)
            }

            null
        }
    }
}
