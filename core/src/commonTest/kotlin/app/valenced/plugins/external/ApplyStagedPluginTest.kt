package app.valenced.plugins.external

import app.valenced.core.readUtf8OrNull
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginPaths
import app.valenced.plugins.PluginSystemError
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonPrimitive
import okio.FileSystem
import okio.ForwardingFileSystem
import okio.IOException
import okio.Path
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

private class FaultyFileSystem(delegate: FileSystem) : ForwardingFileSystem(delegate) {
    var failMove: (Path, Path) -> Boolean = { _, _ -> false }
    var failDelete: (Path) -> Boolean = { false }

    override fun atomicMove(source: Path, target: Path) {
        if (failMove(source, target)) throw IOException("injected move failure: $source -> $target")
        super.atomicMove(source, target)
    }

    override fun deleteRecursively(fileOrDirectory: Path, mustExist: Boolean) {
        if (failDelete(fileOrDirectory)) throw IOException("injected delete failure: $fileOrDirectory")
        super.deleteRecursively(fileOrDirectory, mustExist)
    }
}

class ApplyStagedPluginTest {
    private val fs = FaultyFileSystem(FakeFileSystem())
    private val paths = PluginPaths(fs, "/data".toPath())

    private fun stage(id: String, content: String): StagedPlugin {
        val dir = paths.dist / ".stage-$id"
        fs.deleteRecursively(dir, mustExist = false)
        fs.createDirectories(dir / "lib")
        fs.write(dir / "index.js") { writeUtf8(content) }
        fs.write(dir / "lib" / "util.js") { writeUtf8("util-$content") }
        return StagedPlugin(dir, ExternalManifest(MANIFEST_FORMAT, id, name = id, version = "1.0.0"))
    }

    private fun install(id: String, content: String) = applyStagedPlugin(paths, stage(id, content))

    private fun installed(id: String) = fs.readUtf8OrNull(paths.dist / id / "index.js")

    private fun backupExists(id: String) = fs.exists(paths.backups / id)

    private fun names(dir: Path) = fs.listOrNull(dir).orEmpty().map { it.name }.sorted()

    private fun installFailure(block: () -> Unit) = assertFailsWith<PluginSystemError> { block() }.also {
        assertEquals(PluginErrorCodes.INSTALL_FAILED, it.code)
    }

    @Test
    fun `a first install places the staged files at the plugin directory`() {
        val dest = install("com.example.a", "one")

        assertEquals(paths.dist / "com.example.a", dest)
        assertEquals("one", installed("com.example.a"))
        assertEquals("util-one", fs.readUtf8OrNull(dest / "lib" / "util.js"))
        assertEquals(listOf("com.example.a"), names(paths.dist))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `an update replaces every file of the old version`() {
        install("com.example.a", "one")
        val old = paths.dist / "com.example.a" / "obsolete.js"
        fs.write(old) { writeUtf8("old") }

        install("com.example.a", "two")

        assertEquals("two", installed("com.example.a"))
        assertFalse(fs.exists(old))
        assertEquals("util-two", fs.readUtf8OrNull(paths.dist / "com.example.a" / "lib" / "util.js"))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `updating one plugin leaves the others untouched`() {
        install("com.example.a", "a1")
        install("com.example.b", "b1")

        install("com.example.a", "a2")

        assertEquals("a2", installed("com.example.a"))
        assertEquals("b1", installed("com.example.b"))
        assertEquals(listOf("com.example.a", "com.example.b"), names(paths.dist))
    }

    @Test
    fun `repeated updates leave no temporary directories behind`() {
        repeat(5) { install("com.example.a", "v$it") }

        assertEquals("v4", installed("com.example.a"))
        assertEquals(listOf("com.example.a"), names(paths.dist))
        assertTrue(names(paths.backups).isEmpty())
    }

    @Test
    fun `a failed backup move leaves the old version in place`() {
        install("com.example.a", "old")
        val staged = stage("com.example.a", "new")
        fs.failMove = { _, target -> target == paths.backups / "com.example.a" }

        val error = installFailure { applyStagedPlugin(paths, staged) }

        assertContains(error.message.orEmpty(), "left untouched")
        assertEquals("old", installed("com.example.a"))
        assertTrue(fs.exists(staged.dir))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `a failed commit restores the old version`() {
        install("com.example.a", "old")
        val staged = stage("com.example.a", "new")
        fs.failMove = { source, _ -> source == staged.dir }

        val error = installFailure { applyStagedPlugin(paths, staged) }

        assertContains(error.message.orEmpty(), "previous version was restored")
        assertEquals("old", installed("com.example.a"))
        assertEquals("util-old", fs.readUtf8OrNull(paths.dist / "com.example.a" / "lib" / "util.js"))
        assertFalse(backupExists("com.example.a"))
        assertTrue(fs.exists(staged.dir))
    }

    @Test
    fun `a failed rollback preserves the backup and reports where it is`() {
        install("com.example.a", "old")
        val staged = stage("com.example.a", "new")
        val backup = paths.backups / "com.example.a"
        fs.failMove = { source, target -> source == staged.dir || source == backup && target == paths.dist / "com.example.a" }

        val error = installFailure { applyStagedPlugin(paths, staged) }

        assertContains(error.message.orEmpty(), backup.toString())
        assertEquals(backup.toString(), error.details?.get("backupPath")?.jsonPrimitive?.content)
        assertEquals((paths.dist / "com.example.a").toString(), error.details?.get("pluginPath")?.jsonPrimitive?.content)
        assertEquals("old", fs.readUtf8OrNull(backup / "index.js"))
        assertTrue(error.cause?.suppressed?.isNotEmpty() == true)
    }

    @Test
    fun `a failed cleanup keeps the new version active`() {
        install("com.example.a", "old")
        fs.failDelete = { it == paths.backups / "com.example.a" }

        install("com.example.a", "new")

        assertEquals("new", installed("com.example.a"))
        assertTrue(backupExists("com.example.a"))
    }

    @Test
    fun `a leftover backup is cleared by the next update`() {
        install("com.example.a", "one")
        fs.failDelete = { it == paths.backups / "com.example.a" }
        install("com.example.a", "two")
        fs.failDelete = { false }

        install("com.example.a", "three")

        assertEquals("three", installed("com.example.a"))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `a leftover backup that cannot be removed blocks the update without touching the installed version`() {
        install("com.example.a", "one")
        fs.failDelete = { it == paths.backups / "com.example.a" }
        install("com.example.a", "two")

        val error = installFailure { install("com.example.a", "three") }

        assertContains(error.message.orEmpty(), "leftover backup")
        assertEquals("two", installed("com.example.a"))
    }

    @Test
    fun `an interrupted update is recovered before the next one is applied`() {
        install("com.example.a", "old")
        fs.atomicMove(paths.dist / "com.example.a", paths.backups / "com.example.a")

        install("com.example.a", "new")

        assertEquals("new", installed("com.example.a"))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `an interrupted update is recovered at startup`() {
        install("com.example.a", "old")
        install("com.example.b", "b")
        fs.atomicMove(paths.dist / "com.example.a", paths.backups / "com.example.a")

        val restored = restoreInterruptedReplacements(paths)

        assertEquals(listOf("com.example.a"), restored)
        assertEquals("old", installed("com.example.a"))
        assertEquals("b", installed("com.example.b"))
        assertFalse(backupExists("com.example.a"))
    }

    @Test
    fun `startup recovery never overwrites an installed plugin with its backup`() {
        install("com.example.a", "one")
        fs.failDelete = { it == paths.backups / "com.example.a" }
        install("com.example.a", "two")

        val restored = restoreInterruptedReplacements(paths)

        assertTrue(restored.isEmpty())
        assertEquals("two", installed("com.example.a"))
    }

    @Test
    fun `startup recovery without any backups does nothing`() {
        assertTrue(restoreInterruptedReplacements(paths).isEmpty())
    }

    @Test
    fun `a failed first install reports an error and leaves no plugin behind`() {
        val staged = stage("com.example.a", "new")
        fs.failMove = { source, _ -> source == staged.dir }

        installFailure { applyStagedPlugin(paths, staged) }

        assertFalse(fs.exists(paths.dist / "com.example.a"))
        assertTrue(fs.exists(staged.dir))
    }
}
