#import "Plugins/PluginLoader.h"
#import "Plugins/PluginManifest.h"
#import "Plugins/PluginVersion.h"
#import "Plugins/SourcesStore.h"
#import "Bridge.h"
#import "Utils.h"
#import "Constants.h"
#import "Logger.h"
#import "ValencedCoreBridge.h"

static id ParseJSONObjectOrEmpty(NSString *json) {
    if (!json || json.length == 0) return @{};
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    return parsed ?: @{};
}

#include <dlfcn.h>
#import <CommonCrypto/CommonDigest.h>
#import <UIKit/UIKit.h>
#include <objc/message.h>
#import <objc/runtime.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wincomplete-implementation"
#pragma clang diagnostic ignored "-Wobjc-protocol-method-implementation"

@interface PluginLoader (PendingInstalls)
- (void)storePendingInstall:(NSString *)token record:(PluginRecord *)record;
- (PluginRecord *)pendingInstallForToken:(NSString *)token;
- (void)discardPendingInstalls;
- (NSString *)confirmPendingInstall:(NSString *)token accepted:(BOOL)accepted;
@end

static NSString * const kManifestFile = @"manifest.json";
static NSString * const kShippedManifestFile = @"valenced.manifest.json";
static NSString * const kReservedIds[] = {@"valenced.api", @"discord"};
static NSString *const  kConfirmTmpPrefix = @".confirm-";
// we like super dont need this but its here incase android uses this one day (it definetly wont we will just rewrite it all) (we did infact switch to kmp)
static NSString * const kDexCacheDir = @".dex-cache";

static inline BOOL isReservedPluginId(NSString *pluginId) {
    for (size_t i = 0; i < sizeof(kReservedIds) / sizeof(kReservedIds[0]); i++)
        if ([kReservedIds[i] isEqualToString:pluginId]) return YES;
    return NO;
}

static BOOL JSONBoolValue(NSDictionary *dict, NSString *key) {
    id value = dict[key];
    return [value isKindOfClass:[NSNumber class]] ? [value boolValue] : NO;
}

static NSURL *ShippedManifestURLInBundle(NSBundle *bundle) {
    if (!bundle) return nil;

    NSString *path = [bundle pathForResource:@"valenced.manifest" ofType:@"json"];
    if (path) return [NSURL fileURLWithPath:path];

    NSString *resourcesPath = [bundle pathForResource:@"ValencedManifest" ofType:@"bundle"];
    if (!resourcesPath) return nil;
    path = [resourcesPath stringByAppendingPathComponent:@"valenced.manifest.json"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return nil;
    return [NSURL fileURLWithPath:path];
}

static NSURL *ShippedBundleManifestURL(void) {
    Dl_info info = {};
    if (dladdr((const void *)&ShippedBundleManifestURL, &info) && info.dli_fname) {
        NSString *dir = [[NSString stringWithUTF8String:info.dli_fname] stringByDeletingLastPathComponent];
        NSArray<NSString *> *candidates = @[
            [dir stringByAppendingPathComponent:kShippedManifestFile],
            [dir stringByAppendingPathComponent:@"ValencedManifest.bundle/valenced.manifest.json"],
        ];
        for (NSString *path in candidates) {
            if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
                return [NSURL fileURLWithPath:path];
            }
        }
    }

    NSMutableArray<NSBundle *> *bundles = [NSMutableArray array];
    NSBundle *classBundle = [NSBundle bundleForClass:[PluginLoader class]];
    if (classBundle) [bundles addObject:classBundle];
    NSBundle *mainBundle = [NSBundle mainBundle];
    if (mainBundle) [bundles addObject:mainBundle];

    for (NSBundle *bundle in bundles) {
        NSURL *url = ShippedManifestURLInBundle(bundle);
        if (url) return url;
    }
    return nil;
}

static PluginRecord *BundledPluginRecordFromEntry(NSDictionary *entry, NSString *bundleVersion) {
    if (![entry isKindOfClass:[NSDictionary class]]) return nil;

    NSString *pluginId = [entry[@"id"] isKindOfClass:[NSString class]] ? entry[@"id"] : nil;
    if (pluginId.length == 0) return nil;

    if (isReservedPluginId(pluginId)) return nil;

    NSString *version = [entry[@"version"] isKindOfClass:[NSString class]] ? entry[@"version"] : bundleVersion;
    if (version.length == 0) return nil;

    NSMutableDictionary<NSString *, id> *dependencies = [NSMutableDictionary dictionary];
    NSDictionary *rawDependencies = [entry[@"dependencies"] isKindOfClass:[NSDictionary class]] ? entry[@"dependencies"] : nil;
    for (NSString *depId in rawDependencies) {
        if ([rawDependencies[depId] isKindOfClass:[NSDictionary class]]) dependencies[depId] = rawDependencies[depId];
    }

    if (!isReservedPluginId(pluginId)) {
        dependencies[@"valenced.api"] = dependencies[@"valenced.api"] ?: @{};
        dependencies[@"discord"] = dependencies[@"discord"] ?: @{};
    }

    NSMutableArray<NSString *> *contributors = [NSMutableArray array];
    NSArray *rawContributors =
        [entry[@"contributors"] isKindOfClass:[NSArray class]] ? entry[@"contributors"] : nil;
    for (id contributor in rawContributors) {
        if ([contributor isKindOfClass:[NSString class]]) [contributors addObject:contributor];
    }

    NSMutableDictionary *manifestDict = [NSMutableDictionary dictionaryWithDictionary:@{
        @"format": @1,
        @"id": pluginId,
        @"name": [entry[@"name"] isKindOfClass:[NSString class]] ? entry[@"name"] : pluginId,
        @"description": [entry[@"description"] isKindOfClass:[NSString class]] ? entry[@"description"] : @"",
        @"author": [entry[@"author"] isKindOfClass:[NSString class]] ? entry[@"author"] : @"",
        @"contributors": contributors,
        @"version": version,
        @"dependencies": dependencies,
    }];
    NSString *icon = [entry[@"icon"] isKindOfClass:[NSString class]] ? entry[@"icon"] : nil;
    if (icon.length > 0) manifestDict[@"icon"] = icon;

    NSString *parseError = nil;
    PluginManifest *manifest = [PluginManifest manifestFromDictionary:manifestDict error:&parseError];
    if (!manifest) {
        ValencedLog(@"Skipping bundled plugin '%@': %@", pluginId, parseError ?: @"invalid manifest");
        return nil;
    }

    PluginRecord *record = [PluginRecord recordWithManifest:manifest];
    record.isInternal = YES;
    record.isEssential = JSONBoolValue(entry, @"essential");
    record.isEnabledByDefault = record.isEssential || JSONBoolValue(entry, @"enabledByDefault");
    record.flags = (record.isEssential || record.isEnabledByDefault) ? PluginFlagEnabled : 0;

    NSDictionary *defaultSource = [entry[@"defaultSource"] isKindOfClass:[NSDictionary class]]
        ? entry[@"defaultSource"] : nil;
    NSString *defaultRepo = [defaultSource[@"repo"] isKindOfClass:[NSString class]] ? defaultSource[@"repo"] : nil;
    if (defaultRepo.length > 0) {
        record.defaultSourceRepo = defaultRepo;
        record.defaultSourceChannel = [defaultSource[@"channel"] isKindOfClass:[NSString class]]
            ? defaultSource[@"channel"] : nil;
    }
    return record;
}

BOOL RequireValidPluginId(NSString *id) {
    return ValencedCore_PluginIdIsValid(id.UTF8String) == 1;
}

BOOL RequireValidPluginIdPublic(NSString *id) {
    return RequireValidPluginId(id);
}

@interface PluginFilePickerDelegate : NSObject <UIDocumentPickerDelegate>
@property (nonatomic, weak) PluginLoader *loader;
- (instancetype)initWithLoader:(PluginLoader *)loader;
@end

NSString *PluginErrorCodeString(PluginErrorCode code) {
    switch (code) {
        case PluginErrorManifestInvalid: return @"MANIFEST_INVALID";
        case PluginErrorDependencyMissing: return @"DEPENDENCY_MISSING";
        case PluginErrorDependencyUnsatisfied: return @"DEPENDENCY_UNSATISFIED";
        case PluginErrorDependencyFailed: return @"DEPENDENCY_FAILED";
        case PluginErrorDependencyCycle: return @"DEPENDENCY_CYCLE";
        case PluginErrorLoadFailed: return @"LOAD_FAILED";
        case PluginErrorPluginError: return @"PLUGIN_ERROR";
        case PluginErrorInstallInvalidZip: return @"INSTALL_INVALID_ZIP";
        case PluginErrorInstallVerifyFailed: return @"INSTALL_VERIFY_FAILED";
        case PluginErrorInstallMismatch: return @"INSTALL_MISMATCH";
        case PluginErrorInstallFailed: return @"INSTALL_FAILED";
    }
    return @"UNKNOWN";
}

@implementation PluginErrorInfo

+ (instancetype)errorWithCode:(PluginErrorCode)code message:(NSString *)message stack:(nullable NSString *)stack {
    PluginErrorInfo *e = [[PluginErrorInfo alloc] init];
    e->_code = [PluginErrorCodeString(code) copy];
    e->_message = [message copy];
    e->_stack = [stack copy];
    return e;
}

+ (instancetype)errorWithString:(NSString *)code message:(NSString *)message stack:(nullable NSString *)stack {
    PluginErrorInfo *e = [[PluginErrorInfo alloc] init];
    e->_code = [code copy];
    e->_message = [message copy];
    e->_stack = [stack copy];
    return e;
}

- (NSDictionary *)toDictionary {
    NSMutableDictionary *d = [NSMutableDictionary dictionaryWithDictionary:@{
        @"code": self.code,
        @"message": self.message,
    }];
    if (self.stack) d[@"stack"] = self.stack;
    return d;
}

@end

@implementation PluginRecord

+ (instancetype)recordWithManifest:(PluginManifest *)manifest {
    PluginRecord *r = [[PluginRecord alloc] init];
    r->_manifest = manifest;
    r->_unsatisfiedOptionalDependencies = @[];
    return r;
}

- (BOOL)isEnabled {
    return (self.flags & PluginFlagEnabled) != 0;
}

- (BOOL)isPendingReload {
    return (self.flags & PluginFlagPendingReload) != 0;
}

- (BOOL)wasStartedLate {
    return (self.flags & PluginFlagStartedLate) != 0;
}

- (BOOL)isSessionSkip {
    return self.errorInfo == nil && self.errors.count > 0;
}

- (NSDictionary *)manifestJSPayload {
    NSMutableDictionary *deps = [NSMutableDictionary dictionaryWithCapacity:self.manifest.dependencies.count];
    for (NSString *depId in self.manifest.dependencies) {
        PluginDependency *dep = self.manifest.dependencies[depId];
        NSString *rangeStr = dep.versionRange ? dep.versionRange.stringValue : @"*";
        if (rangeStr.length == 0) rangeStr = @"*";
        deps[depId] = @{@"version": rangeStr, @"optional": @(dep.optional)};
    }
    NSMutableDictionary *m = [NSMutableDictionary dictionaryWithDictionary:@{
        @"format": @1,
        @"id": self.manifest.id,
        @"name": self.manifest.name,
        @"description": self.manifest.descriptionText ?: @"",
        @"author": self.manifest.author ?: @"",
        @"contributors": self.manifest.contributors ?: @[],
        @"icon": self.manifest.icon ?: [NSNull null],
        @"dependencies": deps,
        @"version": @{
            @"nums": self.manifest.version.numbers ?: @[],
            @"label": self.manifest.version.label ?: [NSNull null],
        },
    }];
    return m;
}

- (NSDictionary *)toJSPayloadWithScript:(BOOL)includeScript {
    NSMutableArray<NSDictionary *> *errors = [NSMutableArray array];
    for (PluginErrorInfo *error in self.errors) [errors addObject:[error toDictionary]];
    if (self.errorInfo) [errors addObject:[self.errorInfo toDictionary]];

    NSDictionary *source = nil;
    if (self.hasSource) {
        source = @{@"repo": self.sourceRepo ?: [NSNull null], @"channel": self.sourceChannel ?: REPO_CHANNEL_LATEST};
    }

    NSMutableDictionary *d = [NSMutableDictionary dictionaryWithDictionary:@{
        @"manifest": [self manifestJSPayload],
        @"script": (includeScript && self.scriptContent) ? self.scriptContent : [NSNull null],
        @"internal": @(self.isInternal),
        @"essential": @(self.isEssential),
        @"enabledByDefault": @(self.isEnabledByDefault),
        @"api": @(self.isApi),
        @"source": source ?: [NSNull null],
        @"unsatisfiedOptionalDependencies": self.unsatisfiedOptionalDependencies ?: @[],
        @"errors": errors,
    }];
    if (self.isSessionSkip) d[@"failed"] = @YES;
    return d;
}

@end

@implementation InternalPluginFactory

+ (instancetype)factoryWithManifest:(PluginManifest *)manifest
                              flags:(NSArray<NSString *> *)flags
                         startBlock:(id<Plugin> (^)(void))startBlock {
    InternalPluginFactory *f = [[InternalPluginFactory alloc] init];
    f->_builder = startBlock;
    f->_manifest = manifest;
    for (NSString *flag in flags) {
        if ([flag isEqualToString:@"INTERNAL"]) f->_internalFlag = YES;
        else if ([flag isEqualToString:@"ESSENTIAL"]) f->_essentialFlag = YES;
        else if ([flag isEqualToString:@"ENABLED_BY_DEFAULT"]) f->_enabledByDefaultFlag = YES;
        else if ([flag isEqualToString:@"API"]) f->_apiFlag = YES;
    }
    return f;
}

@end

@interface LoadedPlugin : NSObject
@property (nonatomic, strong) id<Plugin> plugin;
@property (nonatomic, strong) PluginScope *scope;
@property (nonatomic, assign) BOOL started;
@end

@implementation LoadedPlugin
@end

@interface PluginLoader () {
    NSMutableDictionary<NSString *, PluginRecord *> *_records;
    NSMutableDictionary<NSString *, PluginRecord *> *_failureRecords;
    NSArray<InternalPluginFactory *> *_internalFactories;
    NSMutableDictionary<NSString *, NSString *> *_pendingUpdates;
    NSMutableSet<NSString *> *_loadedDylibs;
    NSMutableDictionary<NSString *, LoadedPlugin *> *_loaded;
}
@end

@implementation PluginLoader

+ (instancetype)sharedLoader {
    static PluginLoader *loader;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ loader = [[PluginLoader alloc] init]; });
    return loader;
}

- (instancetype)init {
    self = [super init];
    _records = [NSMutableDictionary dictionary];
    _failureRecords = [NSMutableDictionary dictionary];
    _pendingUpdates = [NSMutableDictionary dictionary];
    _loadedDylibs = [NSMutableSet set];
    _loaded = [NSMutableDictionary dictionary];
    return self;
}

- (NSURL *)pluginsDirectory {
    return [getValencedDirectory() URLByAppendingPathComponent:PLUGINS_DIR];
}

- (NSURL *)pluginStorageRoot {
    return [getValencedDirectory() URLByAppendingPathComponent:PLUGIN_STORAGE_DIR];
}

- (NSURL *)storageDirectoryForPlugin:(NSString *)pluginId {
    return [[self pluginStorageRoot] URLByAppendingPathComponent:pluginId];
}

- (NSDictionary<NSString *, PluginRecord *> *)records {
    return _records;
}

- (BOOL)isReservedPluginId:(NSString *)pluginId {
    return isReservedPluginId(pluginId);
}

- (BOOL)isValidPluginId:(NSString *)pluginId {
    return RequireValidPluginId(pluginId);
}

- (void)setPendingUpdate:(NSString *)pluginId version:(NSString *)version {
    _pendingUpdates[pluginId] = [version copy];
}

- (NSString *)pendingUpdateForPlugin:(NSString *)pluginId {
    return _pendingUpdates[pluginId];
}

- (void)addRecord:(PluginRecord *)record {
    if (!record.manifest.id) return;
    _records[record.manifest.id] = record;
    [_failureRecords removeObjectForKey:record.manifest.id];
}

- (void)forgetRecord:(NSString *)pluginId {
    [_records removeObjectForKey:pluginId];
    [_failureRecords removeObjectForKey:pluginId];
    [_pendingUpdates removeObjectForKey:pluginId];
    [_loadedDylibs removeObject:pluginId];
}

- (NSDictionary<NSString *, PluginManifest *> *)knownManifests {
    NSMutableDictionary<NSString *, PluginManifest *> *known = [NSMutableDictionary dictionary];
    for (NSString *id in _failureRecords) {
        PluginRecord *failure = _failureRecords[id];
        if (failure.manifest) known[id] = failure.manifest;
    }
    for (NSString *id in _records) known[id] = _records[id].manifest;
    return known;
}

- (NSString *)graphManifestsJsonForManifests:(NSDictionary<NSString *, PluginManifest *> *)manifests {
    NSMutableArray<NSDictionary *> *graphManifests = [NSMutableArray arrayWithCapacity:manifests.count];
    for (NSString *id in manifests) {
        PluginManifest *manifest = manifests[id];
        if (!manifest) continue;
        NSMutableDictionary<NSString *, NSDictionary *> *deps = [NSMutableDictionary dictionary];
        for (NSString *depId in manifest.dependencies) {
            PluginDependency *dep = manifest.dependencies[depId];
            PluginVersionRange *range = dep.versionRange ?: [PluginVersionRange anyVersionRange];
            deps[depId] = @{@"version": range.stringValue ?: @"*", @"optional": @(dep.optional)};
        }
        [graphManifests addObject:@{
            @"id": manifest.id,
            @"version": manifest.version.stringValue,
            @"dependencies": deps,
        }];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:graphManifests options:0 error:nil];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

- (NSDictionary<NSString *, PluginVersion *> *)installedVersions {
    NSMutableDictionary<NSString *, PluginVersion *> *versions = [NSMutableDictionary dictionary];
    for (NSString *id in _records) versions[id] = _records[id].manifest.version;
    return versions;
}

- (NSDictionary<NSString *, NSDictionary<NSString *, PluginVersionRange *> *> *)installedDependencies {
    NSMutableDictionary<NSString *, NSDictionary<NSString *, PluginVersionRange *> *> *deps = [NSMutableDictionary dictionary];
    for (NSString *id in _records) {
        PluginManifest *manifest = _records[id].manifest;
        NSMutableDictionary<NSString *, PluginVersionRange *> *ranges = [NSMutableDictionary dictionary];
        for (NSString *depId in manifest.dependencies) {
            ranges[depId] = manifest.dependencies[depId].versionRange ?: [PluginVersionRange anyVersionRange];
        }
        deps[id] = ranges;
    }
    return deps;
}

- (NSArray<InternalPluginFactory *> *)internalFactories {
    static NSArray<InternalPluginFactory *> *factories;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *discordVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"1.0.0";
        PluginVersion *apiVer = [PluginVersion versionFromString:VERSION_CODE error:nil] ?: [PluginVersion versionWithNumbers:@[@1] label:nil];
        PluginVersion *hostVer = [PluginVersion versionFromString:discordVersion error:nil] ?: [PluginVersion versionWithNumbers:@[@1] label:nil];

        PluginManifest *api =
            [PluginManifest manifestWithId:@"valenced.api"
                                      name:@"Valenced Plugin API"
                               description:@"Provides the Valenced plugin API."
                                    author:@"Valenced"
                              contributors:@[]
                                      icon:nil
                              dependencies:@{}
                                   version:apiVer];
        PluginManifest *discord =
            [PluginManifest manifestWithId:@"discord"
                                      name:@"Discord"
                               description:@"Provides the host Discord app version."
                                    author:@"Discord"
                              contributors:@[]
                                      icon:nil
                              dependencies:@{}
                                   version:hostVer];

        id<Plugin> (^noPlugin)(void) = ^id<Plugin> { return nil; };

        factories = @[
            [InternalPluginFactory factoryWithManifest:api
                                                 flags:@[@"INTERNAL", @"ESSENTIAL", @"API"]
                                            startBlock:noPlugin],
            [InternalPluginFactory factoryWithManifest:discord
                                                 flags:@[@"INTERNAL", @"ESSENTIAL", @"API"]
                                            startBlock:noPlugin],
        ];
    });
    return factories;
}

- (NSArray<PluginRecord *> *)bundledRecords {
    NSData *data = ValencedEmbeddedSection("__vmanifest");
    if (!data) {
        NSURL *manifestURL = ShippedBundleManifestURL();
        if (!manifestURL) {
            ValencedLog(@"No shipped bundle manifest found; bundled plugin dependencies are unavailable");
            return @[];
        }
        data = [NSData dataWithContentsOfURL:manifestURL];
    }
    NSDictionary *manifest = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![manifest isKindOfClass:[NSDictionary class]]) {
        ValencedLog(@"Failed to read shipped bundle manifest");
        return @[];
    }

    NSString *bundleVersion = [manifest[@"version"] isKindOfClass:[NSString class]] ? manifest[@"version"] : nil;
    if (bundleVersion.length == 0) {
        ValencedLog(@"Shipped bundle manifest has no version");
        return @[];
    }

    NSArray *entries = [manifest[@"plugins"] isKindOfClass:[NSArray class]] ? manifest[@"plugins"] : @[];
    NSMutableArray<PluginRecord *> *records = [NSMutableArray arrayWithCapacity:entries.count];
    for (id entry in entries) {
        if (![entry isKindOfClass:[NSDictionary class]]) continue;
        PluginRecord *record = BundledPluginRecordFromEntry(entry, bundleVersion);
        if (record) [records addObject:record];
    }
    return records;
}

- (NSArray<PluginRecord *> *)internalRecords {
    static NSArray<PluginRecord *> *records;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSMutableArray *all = [NSMutableArray array];
        NSMutableSet<NSString *> *knownIds = [NSMutableSet set];
        for (InternalPluginFactory *factory in [self internalFactories]) {
            PluginRecord *record = [PluginRecord recordWithManifest:factory.manifest];
            record.isInternal = factory.internalFlag;
            record.isEssential = factory.essentialFlag;
            record.isEnabledByDefault = factory.enabledByDefaultFlag;
            record.isApi = factory.apiFlag;
            record.flags = PluginFlagEnabled;
            [all addObject:record];
            [knownIds addObject:record.manifest.id];
        }
        for (PluginRecord *record in [self bundledRecords]) {
            NSString *pluginId = record.manifest.id;
            if ([knownIds containsObject:pluginId]) continue;
            [all addObject:record];
            [knownIds addObject:pluginId];
        }
        records = all;
    });
    return records;
}

- (void)seedDefaultSourcesForInternalRecords:(NSArray<PluginRecord *> *)records {
    NSDictionary<NSString *, PluginSource *> *existing = SourcesStoreAll();
    for (PluginRecord *record in records) {
        if (!record.defaultSourceRepo) continue;
        NSString *pluginId = record.manifest.id;
        if (existing[pluginId]) continue;
        SourcesStoreSet(pluginId, record.defaultSourceRepo, record.defaultSourceChannel);
    }
}

- (void)loadPlugins {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *dist = [self pluginsDirectory];
    [fm createDirectoryAtURL:dist withIntermediateDirectories:YES attributes:nil error:nil];

    for (NSURL *url in [fm contentsOfDirectoryAtURL:dist includingPropertiesForKeys:nil options:0 error:nil]) {
        NSString *name = url.lastPathComponent;
        if ([name hasPrefix:@"."] && ![name isEqualToString:kDexCacheDir]) [fm removeItemAtURL:url error:nil];
    }

    PluginStatesStore *store = [PluginStatesStore sharedStore];
    [store ensureLoaded];

    [_failureRecords removeAllObjects];
    [_records removeAllObjects];


    NSArray<PluginRecord *> *internals = [self internalRecords];
    [self seedDefaultSourcesForInternalRecords:internals];

    NSDictionary<NSString *, PluginSource *> *sources = SourcesStoreAll();
    NSMutableSet<NSString *> *shadowedIds = [NSMutableSet set];
    for (PluginRecord *record in internals) {
        NSString *pluginId = record.manifest.id;
        if (!sources[pluginId]) continue;
        NSURL *installedManifest = [[dist URLByAppendingPathComponent:pluginId] URLByAppendingPathComponent:kManifestFile];
        if (![fm fileExistsAtPath:installedManifest.path]) continue;
        [shadowedIds addObject:pluginId];
        ValencedLog(@"Using installed copy of internal plugin: %@", pluginId);
    }

    NSMutableArray<PluginRecord *> *known = [NSMutableArray arrayWithCapacity:internals.count];
    NSMutableSet<NSString *> *knownIds = [NSMutableSet set];
    NSMutableDictionary<NSString *, PluginManifest *> *graphKnown = [NSMutableDictionary dictionary];
    for (PluginRecord *record in internals) {
        NSString *pluginId = record.manifest.id;
        if ([shadowedIds containsObject:pluginId]) continue;
        [known addObject:record];
        [knownIds addObject:pluginId];
        graphKnown[pluginId] = record.manifest;
    }

    NSMutableDictionary<NSString *, PluginRecord *> *discovered = [NSMutableDictionary dictionary];
    NSArray<NSURL *> *contents = [fm contentsOfDirectoryAtURL:dist includingPropertiesForKeys:nil options:0 error:nil];
    for (NSURL *url in contents) {
        if ([url.lastPathComponent hasPrefix:@"."]) continue;
        NSURL *manifestURL = [url URLByAppendingPathComponent:kManifestFile];
        if (![fm fileExistsAtPath:manifestURL.path]) continue;
        NSData *data = [NSData dataWithContentsOfURL:manifestURL];
        if (!data) continue;
        NSError *err = nil;
        NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (err || ![json isKindOfClass:[NSDictionary class]]) {
            [self recordFailureForId:url.lastPathComponent
                            manifest:nil
                              errors:@[[PluginErrorInfo errorWithCode:PluginErrorManifestInvalid
                                                              message:@"Failed to read plugin manifest"
                                                                stack:nil]]];
            [self clearPersistedState:url.lastPathComponent];
            continue;
        }
        NSString *parseErr = nil;
        PluginManifest *manifest = [PluginManifest manifestFromDictionary:json error:&parseErr];
        if (!manifest) {
            [self recordFailureForId:url.lastPathComponent
                            manifest:nil
                              errors:@[[PluginErrorInfo errorWithCode:PluginErrorManifestInvalid
                                                              message:parseErr ?: @"Invalid manifest"
                                                                stack:nil]]];
            [self clearPersistedState:url.lastPathComponent];
            continue;
        }
        if ([knownIds containsObject:manifest.id]) {
            ValencedLog(@"Ignoring installed copy of internal plugin '%@' in '%@'", manifest.id, url.lastPathComponent);
            continue;
        }
        if (discovered[manifest.id]) continue;
        [_failureRecords removeObjectForKey:manifest.id];
        PluginRecord *record = [PluginRecord recordWithManifest:manifest];
        record.bundlePath = [url path];
        record.scriptContent = [self readScriptForDirectory:url manifest:manifest];
        discovered[manifest.id] = record;
        graphKnown[manifest.id] = manifest;
    }

    NSString *graphJson = [self graphManifestsJsonForManifests:graphKnown];
    if (!graphJson) {
        ValencedLog(@"loadPlugins: failed to encode manifests for the dependency graph");
        return;
    }

    char *graphError = NULL;
    char *graphResultRaw = ValencedCore_PluginsLoadOrder(graphJson.UTF8String, &graphError);
    if (!graphResultRaw) {
        ValencedLog(@"loadPlugins: failed to compute load order: %@", ValencedCore_ConsumeError(graphError));
        return;
    }
    NSString *graphResultJson = ValencedCore_ConsumeString(graphResultRaw);
    NSData *graphResultData = [graphResultJson dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *graphResult = graphResultData
        ? [NSJSONSerialization JSONObjectWithData:graphResultData options:0 error:nil] : nil;
    if (![graphResult isKindOfClass:[NSDictionary class]]) {
        ValencedLog(@"loadPlugins: unreadable load order result");
        return;
    }

    NSDictionary *unsatisfiedOptional = graphResult[@"unsatisfiedOptional"];
    if ([unsatisfiedOptional isKindOfClass:[NSDictionary class]]) {
        for (NSString *pluginId in unsatisfiedOptional) {
            PluginRecord *record = discovered[pluginId];
            NSArray *deps = unsatisfiedOptional[pluginId];
            if (record && [deps isKindOfClass:[NSArray class]]) {
                record.unsatisfiedOptionalDependencies = (NSArray<NSString *> *)deps;
            }
        }
    }

    NSDictionary *dropped = graphResult[@"dropped"];
    if ([dropped isKindOfClass:[NSDictionary class]]) {
        for (NSString *pluginId in dropped) {
            PluginRecord *record = discovered[pluginId];
            NSArray *problems = dropped[pluginId];
            if (!record || ![problems isKindOfClass:[NSArray class]]) continue;
            NSMutableArray<PluginErrorInfo *> *errors = [NSMutableArray arrayWithCapacity:problems.count];
            for (NSDictionary *problem in problems) {
                NSString *code = problem[@"code"];
                NSString *reason = problem[@"reason"];
                [errors addObject:[PluginErrorInfo errorWithString:code ?: @"UNKNOWN"
                                                           message:[@"Unsatisfied dependency: " stringByAppendingString:reason ?: @""]
                                                             stack:nil]];
            }
            [self recordFailureForId:pluginId manifest:record.manifest errors:errors];
        }
    }

    NSArray *cycles = graphResult[@"cycles"];
    if ([cycles isKindOfClass:[NSArray class]]) {
        for (NSString *pluginId in cycles) {
            PluginRecord *record = discovered[pluginId];
            if (!record) continue;
            [self recordFailureForId:pluginId
                            manifest:record.manifest
                              errors:@[[PluginErrorInfo errorWithCode:PluginErrorDependencyCycle message:@"Dependency cycle" stack:nil]]];
        }
    }

    NSMutableArray<PluginRecord *> *external = [NSMutableArray array];
    NSArray *orderedIds = graphResult[@"ordered"];
    if ([orderedIds isKindOfClass:[NSArray class]]) {
        for (NSString *pluginId in orderedIds) {
            PluginRecord *record = discovered[pluginId];
            if (record) [external addObject:record];
        }
    }

    for (PluginRecord *record in external) {
        NSString *id = record.manifest.id;
        NSMutableArray<PluginErrorInfo *> *failedDeps = [NSMutableArray array];
        for (NSString *depId in record.manifest.dependencies) {
            if (isReservedPluginId(depId)) continue;
            PluginDependency *dep = record.manifest.dependencies[depId];
            if (!dep.optional && _failureRecords[depId]) {
                [failedDeps addObject:[PluginErrorInfo errorWithCode:PluginErrorDependencyFailed
                                                             message:[NSString stringWithFormat:@"Dependency '%@' failed to load", depId]
                                                               stack:nil]];
            }
        }
        if (failedDeps.count > 0) {
            [self recordFailureForId:id manifest:record.manifest errors:failedDeps];
            continue;
        }

        _records[id] = record;
    }

    for (PluginRecord *record in known) _records[record.manifest.id] = record;

    NSMutableArray<PluginRecord *> *loadable = [NSMutableArray arrayWithArray:known];
    [loadable addObjectsFromArray:external];

    [store batchSave:^{
        for (PluginRecord *record in loadable) {
            NSString *id = record.manifest.id;
            BOOL essential = record.isEssential || isReservedPluginId(id);
            BOOL enabledByDefault = record.isEnabledByDefault || [id hasPrefix:@"internal."];

            BOOL shouldLoad = [[store states] isPluginEnabled:id] || essential
                || (enabledByDefault && ![[store states] hasPlugin:id]);
            if (!shouldLoad) {
                ValencedLog(@"Skipping disabled plugin: %@", id);
                continue;
            }
            record.flags = [[store states] isPluginEnabled:id] || essential ? PluginFlagEnabled : record.flags;
            [self startRecord:record late:NO];
        }
    }];

    ValencedLog(@"loadPlugins: %lu records, %lu failures, %lu pending updates, defaultsOnly=%d",
                (unsigned long)_records.count, (unsigned long)_failureRecords.count,
                (unsigned long)_pendingUpdates.count, store.defaultsOnly);
}

- (void)recordFailureForId:(NSString *)id manifest:(PluginManifest *)manifest errors:(NSArray<PluginErrorInfo *> *)errors {
    PluginRecord *record = manifest ? [PluginRecord recordWithManifest:manifest] : nil;
    if (!record) {
        PluginManifest *placeholder = [PluginManifest manifestWithId:id name:id description:@"" author:@"" contributors:@[] icon:nil dependencies:@{} version:[PluginVersion versionWithNumbers:@[@0] label:nil]];
        record = [PluginRecord recordWithManifest:placeholder];
        record.flags = 0;
    } else {
        NSNumber *state = [[PluginStatesStore sharedStore] loadPluginFlags:id];
        NSInteger flags = state ? state.integerValue : 0;
        record.flags = flags & ~PluginFlagPendingReload;
    }
    record.errors = errors;
    _failureRecords[id] = record;
}

- (NSString *)readScriptForDirectory:(NSURL *)dir manifest:(PluginManifest *)manifest {
    if (!manifest.distScript) return nil;
    NSString *scriptPath = [dir.path stringByAppendingPathComponent:manifest.distScript];
    NSString *canonDir = [[dir path] stringByResolvingSymlinksInPath];
    if (![canonDir hasSuffix:@"/"]) canonDir = [canonDir stringByAppendingString:@"/"];
    NSString *canonScript = [scriptPath stringByResolvingSymlinksInPath];
    if (![canonScript hasPrefix:canonDir]) {
        ValencedLog(@"readScript: dist.script '%@' escapes plugin directory, ignoring", manifest.distScript);
        return nil;
    }
    NSError *err = nil;
    NSString *content = [NSString stringWithContentsOfFile:scriptPath encoding:NSUTF8StringEncoding error:&err];
    if (!content && err) {
        ValencedLog(@"readScript: dist.script does not exist, skipping JS for %@: %@", manifest.id, manifest.distScript);
        return nil;
    }
    return content;
}

- (nullable PluginRecord *)readExternalPluginDir:(NSURL *)dir
                                   knownVersions:(NSDictionary<NSString *, PluginVersion *> *)knownVersions
                                           error:(NSString * _Nullable * _Nullable)error {
    NSURL *manifestURL = [dir URLByAppendingPathComponent:kManifestFile];
    NSData *data = [NSData dataWithContentsOfURL:manifestURL];
    NSDictionary *json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSString *parseErr = nil;
    PluginManifest *manifest = json ? [PluginManifest manifestFromDictionary:json error:&parseErr] : nil;
    if (!manifest) {
        if (error) *error = parseErr ?: @"Failed to read plugin manifest";
        return nil;
    }

    NSMutableArray<NSString *> *unsatisfiedOptionals = [NSMutableArray array];
    for (NSString *depId in manifest.dependencies) {
        PluginDependency *dep = manifest.dependencies[depId];
        PluginVersionRange *range = dep.versionRange ?: [PluginVersionRange anyVersionRange];
        PluginVersion *version = knownVersions[depId];
        BOOL satisfied = version != nil && [range satisfies:version];
        if (satisfied) continue;

        if (dep.optional) {
            if (version) {
                ValencedLog(@"Optional dependency '%@' version %@ does not satisfy '%@' for plugin '%@'; ignoring",
                            depId, version.stringValue, dep.versionRange.stringValue, manifest.id);
                [unsatisfiedOptionals addObject:depId];
            }
            continue;
        }

        if (error) {
            *error = version
                ? [NSString stringWithFormat:@"Plugin '%@': dependency '%@' version %@ does not satisfy '%@'",
                                             manifest.id, depId, version.stringValue, dep.versionRange.stringValue]
                : [NSString stringWithFormat:@"Plugin '%@': missing dependency '%@'", manifest.id, depId];
        }
        return nil;
    }

    PluginRecord *record = [PluginRecord recordWithManifest:manifest];
    record.bundlePath = dir.path;
    record.unsatisfiedOptionalDependencies = unsatisfiedOptionals;
    record.scriptContent = [self readScriptForDirectory:dir manifest:manifest];
    return record;
}

- (LoadedPlugin *)loadRecord:(PluginRecord *)record late:(BOOL)late {
    if (late) record.flags |= PluginFlagStartedLate;
    if (!record.bundlePath) return nil;

    NSURL *dylibURL = [NSURL fileURLWithPath:[record.bundlePath stringByAppendingPathComponent:PLUGIN_BINARY_FILE]];
    if (![[NSFileManager defaultManager] fileExistsAtPath:dylibURL.path]) return nil;

    id<Plugin> plugin = nil;

    // only in developer builds right now, should this probably have its own flag? yeah
    #ifdef DEBUG
    void *handle = dlopen(dylibURL.path.UTF8String, RTLD_NOW);
    if (!handle) {
        NSString *msg = [NSString stringWithUTF8String:dlerror()] ?: @"dlopen failed";
        ValencedLog(@"startNative: dlopen failed for %@: %@", record.manifest.id, msg);
        record.errorInfo = [PluginErrorInfo errorWithCode:PluginErrorLoadFailed message:msg stack:nil];
        return nil;
    }

    void *symbol = dlsym(handle, "ValencedPluginMain");
    if (!symbol) {
        ValencedLog(@"startNative: missing ValencedPluginMain symbol in %@", record.manifest.id);
        record.errorInfo = [PluginErrorInfo errorWithCode:PluginErrorLoadFailed message:@"Missing ValencedPluginMain symbol" stack:nil];
        dlclose(handle);
        return nil;
    }

    id (*factory)(void) = (id (*)(void))symbol;
    plugin = factory();
    if (!plugin) {
        ValencedLog(@"startNative: ValencedPluginMain returned nil for %@", record.manifest.id);
        record.errorInfo = [PluginErrorInfo errorWithCode:PluginErrorLoadFailed message:@"ValencedPluginMain returned nil" stack:nil];
        dlclose(handle);
        return nil;
    }
    [_loadedDylibs addObject:record.manifest.id];
    #endif

    if (!plugin) {
        ValencedLog(@"Ignoring native binary for %@: native plugins are debug-only", record.manifest.id);
        return nil;
    }

    PluginScope *scope = [[PluginScope alloc] initWithManifest:record.manifest];
    [scope setStorageDir:[self storageDirectoryForPlugin:record.manifest.id].path];
    [scope setEnabled:(record.flags & PluginFlagEnabled) != 0];
    [scope setStartedLate:(record.flags & PluginFlagStartedLate) != 0];

    LoadedPlugin *entry = [[LoadedPlugin alloc] init];
    entry.plugin = plugin;
    entry.scope = scope;
    entry.started = YES;
    _loaded[record.manifest.id] = entry;

    @try {
        [plugin start:scope];
    } @catch (NSException *e) {
        record.errorInfo = [PluginErrorInfo errorWithCode:PluginErrorPluginError message:e.reason stack:e.callStackSymbols.description];
    }

    ValencedLog(@"Started plugin: %@", record.manifest.id);
    return entry;
}

- (void)startRecord:(PluginRecord *)record late:(BOOL)late {
    [self loadRecord:record late:late];
}

- (BOOL)isEssentialPlugin:(NSString *)pluginId {
    PluginRecord *rec = _records[pluginId];
    if (rec && (rec.isEssential || isReservedPluginId(pluginId))) return YES;
    return NO;
}

- (BOOL)setEnabled:(NSString *)pluginId enabled:(BOOL)enabled requiredByUser:(BOOL)requiredByUser {
    if (enabled) {
        [self enablePlugin:pluginId requiredByUser:requiredByUser];
    } else {
        [self disablePlugin:pluginId];
    }
    return YES;
}

- (void)enablePlugin:(NSString *)pluginId requiredByUser:(BOOL)requiredByUser {
    NSInteger flags = PluginFlagEnabled | (requiredByUser ? PluginFlagRequiredByUser : 0);
    PluginRecord *record = _records[pluginId];
    if (record) record.flags |= flags;
    PluginsStates *states = [[PluginStatesStore sharedStore] states];
    if (states) [states setPluginFlags:pluginId flags:flags];
    [[PluginStatesStore sharedStore] writeNow];
}

- (BOOL)disablePlugin:(NSString *)pluginId {
    if ([self isEssentialPlugin:pluginId]) {
        ValencedLog(@"Plugin %@ is essential and cannot be disabled", pluginId);
        return NO;
    }

    NSMutableSet<NSString *> *toDisable = [NSMutableSet setWithObject:pluginId];
    NSString *graphJson = [self graphManifestsJsonForManifests:[self knownManifests]];
    if (graphJson) {
        char *dependentsError = NULL;
        char *dependentsRaw = ValencedCore_RequiredDependents(graphJson.UTF8String, pluginId.UTF8String, &dependentsError);
        if (dependentsRaw) {
            NSString *dependentsJson = ValencedCore_ConsumeString(dependentsRaw);
            NSData *dependentsData = [dependentsJson dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = dependentsData
                ? [NSJSONSerialization JSONObjectWithData:dependentsData options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSArray class]]) {
                for (NSString *dependentId in (NSArray *)parsed) {
                    if ([self isEssentialPlugin:dependentId]) {
                        ValencedLog(@"Not disabling essential plugin %@ despite its required dependency being disabled", dependentId);
                        continue;
                    }
                    [toDisable addObject:dependentId];
                }
            } else {
                ValencedLog(@"disablePlugin: unreadable required dependents result");
            }
        } else {
            ValencedLog(@"disablePlugin: failed to compute required dependents: %@", ValencedCore_ConsumeError(dependentsError));
        }
    } else {
        ValencedLog(@"disablePlugin: failed to encode manifests for the dependency graph");
    }

    PluginsStates *states = [[PluginStatesStore sharedStore] states];
    for (NSString *id in toDisable) {
        if (states) [states setPluginFlags:id flags:0];
        PluginRecord *record = _records[id];
        if (record) record.flags = 0;
    }
    [[PluginStatesStore sharedStore] writeNow];

    [self stopPlugin:pluginId];
    return YES;
}

- (void)stopPlugin:(NSString *)pluginId {
    if (_loaded[pluginId]) EmitJSEventArgs(EVENT_PLUGIN_STOPPING, @[pluginId]);
    [self stopNativePlugin:pluginId];
}

- (void)stopNativePlugin:(NSString *)pluginId {
    LoadedPlugin *entry = _loaded[pluginId];
    if (!entry) return;

    NSMutableArray<NSString *> *dependents = [NSMutableArray array];
    for (NSString *dependentId in _loaded) {
        PluginDependency *dep = _loaded[dependentId].scope.manifest.dependencies[pluginId];
        if (!dep) continue;
        if (dep.optional && [_records[dependentId].unsatisfiedOptionalDependencies containsObject:pluginId]) continue;
        [dependents addObject:dependentId];
    }
    for (NSString *dependentId in dependents) {
        if (!_loaded[dependentId]) continue;
        ValencedLog(@"Stopping %@: its dependency %@ is stopping", dependentId, pluginId);
        [self stopNativePlugin:dependentId];
    }

    entry = _loaded[pluginId];
    if (!entry) return;
    [_loaded removeObjectForKey:pluginId];
    if (entry.started) {
        @try {
            [entry.plugin stop:entry.scope];
        } @catch (NSException *e) {
            ValencedLog(@"Plugin %@ threw in stop(): %@", pluginId, e.reason ?: @"");
        }
    }
    entry.started = NO;
}

- (void)addPluginFlags:(PluginFlag)flags forPlugin:(NSString *)pluginId {
    PluginRecord *record = _records[pluginId];
    NSInteger newFlags = (record ? record.flags : 0) | flags;
    if (record) record.flags = newFlags;
    if (record && record.manifest) {
        [[PluginStatesStore sharedStore] updatePluginFlags:record.manifest flags:newFlags];
    }
    NSString *slot = ValencedCore_ConsumeStringOrNil(ValencedCore_PluginStatesBootSlot(NULL)) ?: @"primary";
    EmitJSEventArgs(@"valenced.plugins.states.update", @[slot, pluginId, PluginStatePayloadForFlags(newFlags)]);
}

- (void)clearPersistedState:(NSString *)pluginId {
    PluginsStates *states = [[PluginStatesStore sharedStore] states];
    if (states) [states removePlugin:pluginId];
    [[PluginStatesStore sharedStore] writeNow];
}

- (BOOL)isPluginEnabledNow:(NSString *)pluginId {
    LoadedPlugin *entry = _loaded[pluginId];
    if (entry) return entry.scope.isEnabled;
    PluginStatesStore *store = [PluginStatesStore sharedStore];
    if ([[store states] isPluginEnabledInSaved:pluginId]) return YES;
    PluginRecord *record = _records[pluginId];
    if (!record) return NO;
    return record.isEssential || (record.isEnabledByDefault && ![[store states] hasPluginInSaved:pluginId]);
}

- (NSArray<NSDictionary *> *)dependencyProblemsForPlugin:(NSString *)pluginId {
    PluginRecord *record = _records[pluginId];
    NSMutableArray *problems = [NSMutableArray array];
    if (!record) return problems;
    for (NSString *depId in record.manifest.dependencies) {
        PluginDependency *dep = record.manifest.dependencies[depId];
        if (dep.optional) continue;

        NSDictionary *(^problem)(PluginVersion *, BOOL) = ^NSDictionary *(PluginVersion *installed, BOOL depEnabled) {
            return @{
                @"id": depId,
                @"required": dep.versionRange.stringValue ?: @"*",
                @"installed": installed ? installed.stringValue : [NSNull null],
                @"enabled": @(depEnabled),
            };
        };

        PluginRecord *depRecord = _records[depId];
        PluginVersion *installed = depRecord ? depRecord.manifest.version : nil;
        PluginVersionRange *range = dep.versionRange ?: [PluginVersionRange anyVersionRange];
        if (!installed) {
            [problems addObject:problem(nil, NO)];
        } else if (![range satisfies:installed]) {
            [problems addObject:problem(installed, [self isPluginEnabledNow:depId])];
        } else if (![self isPluginEnabledNow:depId]) {
            [problems addObject:problem(installed, NO)];
        }
    }
    return problems;
}

- (void)uninstall:(NSString *)pluginId {
    PluginRecord *factory = _records[pluginId];
    if (factory && (factory.isInternal || isReservedPluginId(pluginId))) {
        ValencedLog(@"Plugin %@ is internal and cannot be uninstalled", pluginId);
        return;
    }

    [self disablePlugin:pluginId];
    [self forgetRecord:pluginId];

    if (!RequireValidPluginId(pluginId)) return;

    NSFileManager *fm = [NSFileManager defaultManager];
    [fm removeItemAtURL:[[self pluginsDirectory] URLByAppendingPathComponent:pluginId] error:nil];
    [fm removeItemAtURL:[self storageDirectoryForPlugin:pluginId] error:nil];

    [self clearPersistedState:pluginId];
    SourcesStoreRemove(pluginId);

    ValencedLog(@"Uninstalled plugin: %@", pluginId);
    EmitJSEvent(EVENT_DEPENDENCIES_UPDATED, @{});
}

- (BOOL)startNative:(NSString *)pluginId {
    LoadedPlugin *entry = _loaded[pluginId];
    if (entry) {
        if (!entry.started) {
            PluginRecord *record = _records[pluginId];
            record.flags |= PluginFlagStartedLate;
            [self addPluginFlags:PluginFlagStartedLate forPlugin:pluginId];
            [entry.scope setStartedLate:YES];
            @try {
                [entry.plugin start:entry.scope];
            } @catch (NSException *e) {
                ValencedLog(@"Plugin %@ threw in start(): %@", pluginId, e.reason ?: @"");
                return NO;
            }
            entry.started = YES;
        }
        return YES;
    }

    PluginRecord *record = _records[pluginId];
    if (!record) {
        ValencedLog(@"startNative: '%@' has no native record (JS-only or unknown)", pluginId);
        return YES;
    }
    if (!record.bundlePath) {
        ValencedLog(@"startNative: %@ is JS-only (no bundle path); JS handles it", pluginId);
        return YES;
    }
    NSURL *dylibURL = [NSURL fileURLWithPath:[record.bundlePath stringByAppendingPathComponent:PLUGIN_BINARY_FILE]];
    if (![[NSFileManager defaultManager] fileExistsAtPath:dylibURL.path]) {
        ValencedLog(@"startNative: %@ is JS-only (no dylib); JS handles it", pluginId);
        return YES;
    }
    ValencedLog(@"startNative: loading dylib for %@", pluginId);
    LoadedPlugin *loaded = [self loadRecord:record late:YES];
    if (!loaded) {
        ValencedLog(@"startNative: failed to load %@: %@", pluginId,
                    record.errorInfo.message ?: @"unknown error");
        return NO;
    }
    return YES;
}

- (NSArray<PluginRecord *> *)listableRecords {
    NSMutableArray *result = [NSMutableArray arrayWithArray:_records.allValues];
    for (NSString *id in _failureRecords) {
        if (_records[id]) continue;
        PluginRecord *failure = _failureRecords[id];
        if (!failure.manifest) continue;
        [result addObject:failure];
    }
    return result;
}

- (NSURL *)stagingDirectoryForToken:(NSString *)prefix token:(NSString *)token {
    return [[self pluginsDirectory] URLByAppendingPathComponent:[prefix stringByAppendingString:token]];
}

- (nullable PluginRecord *)extractPluginZipAtPath:(NSString *)zipPath
                                             root:(NSURL *)root
                                          tmpName:(NSString *)tmpName
                                            error:(PluginErrorInfo * _Nullable * _Nullable)error {
    (void)root;
    NSFileManager *fm = [NSFileManager defaultManager];

    char *code = NULL;
    char *message = NULL;
    char *stagedRaw = ValencedCore_StagePluginZip(zipPath.UTF8String, tmpName.UTF8String, &code, &message);
    if (!stagedRaw) {
        NSString *errorCode = code ? ValencedCore_ConsumeString(code) : PluginErrorCodeString(PluginErrorInstallFailed);
        NSString *errorMessage = ValencedCore_ConsumeError(message);
        if (error) *error = [PluginErrorInfo errorWithString:errorCode message:errorMessage stack:nil];
        return nil;
    }
    NSString *stagedPath = ValencedCore_ConsumeString(stagedRaw);
    NSURL *tmpDir = [NSURL fileURLWithPath:stagedPath];

    NSURL *manifestURL = [tmpDir URLByAppendingPathComponent:kManifestFile];
    NSData *manifestData = [NSData dataWithContentsOfURL:manifestURL];
    NSError *jsonErr = nil;
    NSDictionary *raw = manifestData ? [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:&jsonErr] : nil;
    if (jsonErr || ![raw isKindOfClass:[NSDictionary class]]) {
        [fm removeItemAtURL:tmpDir error:nil];
        if (error) *error = [PluginErrorInfo errorWithCode:PluginErrorManifestInvalid message:@"Invalid manifest.json" stack:nil];
        return nil;
    }

    NSString *parseErr = nil;
    PluginManifest *manifest = [PluginManifest manifestFromDictionary:raw error:&parseErr];
    if (!manifest) {
        [fm removeItemAtURL:tmpDir error:nil];
        if (error) *error = [PluginErrorInfo errorWithCode:PluginErrorManifestInvalid
                                                  message:[NSString stringWithFormat:@"Invalid manifest.json: %@", parseErr ?: @""]
                                                    stack:nil];
        return nil;
    }

    PluginRecord *record = [PluginRecord recordWithManifest:manifest];
    record.bundlePath = tmpDir.path;
    return record;
}

- (nullable NSURL *)applyStagedDirectory:(NSURL *)stagedDir forPluginId:(NSString *)pluginId {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *dist = [self pluginsDirectory];
    NSURL *dest = [dist URLByAppendingPathComponent:pluginId];

    [fm removeItemAtURL:dest error:nil];
    if (![fm moveItemAtURL:stagedDir toURL:dest error:nil]) {
        [fm copyItemAtURL:stagedDir toURL:dest error:nil];
        [fm removeItemAtURL:stagedDir error:nil];
    }
    return dest;
}

- (void)installFromFile:(NSString *)filePath completion:(void (^)(NSString * _Nullable error, PluginRecord * _Nullable record))completion {
    if (!filePath) {
        if (completion) completion(@"Expected a file path", nil);
        return;
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:filePath]) {
        if (completion) completion(@"File not found", nil);
        return;
    }

    NSURL *fileURL = [NSURL fileURLWithPath:filePath];
    NSString *ext = fileURL.pathExtension.lowercaseString;
    if (![ext isEqualToString:@"zip"] && ![ext isEqualToString:@"valplugin"]) {
        if (completion) completion(@"File is not a valid plugin archive", nil);
        return;
    }

    [self discardPendingInstalls];

    NSURL *root = [self pluginsDirectory];
    NSString *token = [[NSUUID UUID] UUIDString];
    PluginErrorInfo *stageError = nil;
    PluginRecord *staged = [self extractPluginZipAtPath:filePath
                                                   root:root
                                                tmpName:[kConfirmTmpPrefix stringByAppendingString:token]
                                                  error:&stageError];
    if (!staged) {
        EmitJSEvent(EVENT_PLUGIN_INSTALL_RESULT, @{
            @"error": stageError ? [stageError toDictionary]
                                 : @{@"code": PluginErrorCodeString(PluginErrorInstallFailed), @"message": @"Failed to stage plugin"},
        });
        if (completion) completion(stageError.message ?: @"Failed to stage plugin", nil);
        return;
    }

    PluginRecord *existing = _records[staged.manifest.id];
    NSString *replacesVersion = existing ? existing.manifest.version.stringValue : nil;
    [self storePendingInstall:token record:staged];
    EmitJSEvent(EVENT_PLUGIN_INSTALL_READY, @{
        @"token": token,
        @"manifest": staged.manifest.toDictionary,
        @"replaces": replacesVersion ?: [NSNull null],
    });

    if (completion) completion(nil, staged);
}

- (void)presentFilePickerForInstall {
    Class pickerClass = NSClassFromString(@"UIDocumentPickerViewController");
    if (!pickerClass) return;

    SEL sel = @selector(initWithDocumentTypes:inMode:);
    if (![pickerClass respondsToSelector:sel]) return;
    id picker = ((id (*)(Class, SEL, NSArray *, NSInteger))objc_msgSend)(pickerClass, sel, @[@"public.zip-archive", @"public.zip"], 0);
    if (!picker) return;

    UIViewController *root = [UIApplication sharedApplication].windows.firstObject.rootViewController;
    if (!root) return;

    id delegate = [[PluginFilePickerDelegate alloc] initWithLoader:self];
    SEL setDelegate = @selector(setDelegate:);
    ((void (*)(id, SEL, id))objc_msgSend)(picker, setDelegate, delegate);

    static char kPickerDelegateKey;
    objc_setAssociatedObject(picker, &kPickerDelegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    id popover = ((id (*)(id, SEL))objc_msgSend)(picker, @selector(popoverPresentationController));
    if (popover) {
        ((void (*)(id, SEL, id))objc_msgSend)(popover, @selector(setSourceView:), root.view);
        ((void (*)(id, SEL, CGRect))objc_msgSend)(popover, @selector(setSourceRect:), root.view.bounds);
    }

    SEL present = @selector(presentViewController:animated:completion:);
    ((void (*)(id, SEL, id, BOOL, void *))objc_msgSend)(root, present, picker, YES, NULL);
}

@end

static NSMutableDictionary<NSString *, PluginRecord *> *pendingInstalls(void) {
    static NSMutableDictionary *installs;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ installs = [NSMutableDictionary dictionary]; });
    return installs;
}

@implementation PluginLoader (PendingInstalls)

- (void)storePendingInstall:(NSString *)token record:(PluginRecord *)record {
    pendingInstalls()[token] = record;
}

- (PluginRecord *)pendingInstallForToken:(NSString *)token {
    return pendingInstalls()[token];
}

- (void)discardPendingInstalls {
    NSFileManager *fm = [NSFileManager defaultManager];
    for (PluginRecord *staged in pendingInstalls().allValues) {
        if (staged.bundlePath) [fm removeItemAtPath:staged.bundlePath error:nil];
    }
    [pendingInstalls() removeAllObjects];
}

- (NSString *)confirmPendingInstall:(NSString *)token accepted:(BOOL)accepted {
    PluginRecord *staged = pendingInstalls()[token];
    [pendingInstalls() removeObjectForKey:token];
    if (!staged || !accepted) {
        if (staged.bundlePath) [[NSFileManager defaultManager] removeItemAtPath:staged.bundlePath error:nil];
        return @"cancelled";
    }

    BOOL isUpdate = _records[staged.manifest.id] != nil || _pendingUpdates[staged.manifest.id] != nil;
    NSURL *dir = [self applyStagedDirectory:[NSURL fileURLWithPath:staged.bundlePath]
                                forPluginId:staged.manifest.id];
    if (!dir) return @"cancelled";

    if (isUpdate) {
        [self setPendingUpdate:staged.manifest.id version:staged.manifest.version.stringValue];
        SourcesStoreSet(staged.manifest.id, nil, nil);
        EmitJSEvent(EVENT_PLUGIN_UPDATED, @{
            @"id": staged.manifest.id,
            @"version": staged.manifest.version.stringValue,
        });
        EmitJSEvent(EVENT_DEPENDENCIES_UPDATED, @{});
        return @"pending";
    }

    [self clearPersistedState:staged.manifest.id];
    SourcesStoreSet(staged.manifest.id, nil, nil);
    staged.bundlePath = dir.path;
    staged.scriptContent = [self readScriptForDirectory:dir manifest:staged.manifest];
    [self addRecord:staged];
    PluginRecord *record = _records[staged.manifest.id];
    record.flags = 0;
    EmitJSEvent(EVENT_PLUGIN_INSTALL_RESULT, @{
        @"error": @NO,
        @"plugin": [record toJSPayloadWithScript:YES],
    });
    EmitJSEvent(EVENT_DEPENDENCIES_UPDATED, @{});
    return @"installed";
}

@end

@implementation PluginFilePickerDelegate

- (instancetype)initWithLoader:(PluginLoader *)loader {
    self = [super init];
    if (self) _loader = loader;
    return self;
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    [controller dismissViewControllerAnimated:YES completion:nil];
    NSURL *url = urls.firstObject;
    if (!url) return;

    BOOL secured = [url startAccessingSecurityScopedResource];
    NSString *copyPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"plugin-import-%@.%@", [[NSUUID UUID] UUIDString], url.pathExtension ?: @"zip"]];
    NSError *copyError = nil;
    [[NSFileManager defaultManager] copyItemAtPath:url.path toPath:copyPath error:&copyError];
    if (secured) [url stopAccessingSecurityScopedResource];
    if (copyError) {
        EmitJSEventArgs(EVENT_PLUGIN_ERRORED, @[@"", @[@{@"code": @"INSTALL_FAILED", @"message": copyError.localizedDescription ?: @"Failed to read selected file"}]]);
        return;
    }

    [_loader installFromFile:copyPath completion:^(NSString * _Nullable error, PluginRecord * _Nullable record) {
        [[NSFileManager defaultManager] removeItemAtPath:copyPath error:nil];
        if (error) {
            EmitJSEventArgs(EVENT_PLUGIN_ERRORED, @[@"", @[@{@"code": @"INSTALL_FAILED", @"message": error}]]);
        }
        (void)record;
    }];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    [controller dismissViewControllerAnimated:YES completion:nil];
}

@end

NSDictionary *ExecuteInstallPlan(NSDictionary *plan, BOOL (^isInstalled)(NSString *pluginId), BOOL (^isPendingReload)(NSString *pluginId), void (^setPendingUpdate)(NSString *pluginId, NSString *version));
NSDictionary *ListUpdatesForRepo(NSString *url, PluginVersion * (^installedVersion)(NSString *pluginId), NSString * (^pendingUpdate)(NSString *pluginId));

@implementation PluginLoader (BridgeMethods)

- (void)registerLoaderMethods {
    PluginLoader *__weak weakLoader = self;

    bridgeHandlers()[@"valenced.plugins.getConstants"] = ^NSDictionary *(NSArray *args) {
        return @{@"result": @{
            @"storageRootPath": [weakLoader pluginStorageRoot].path ?: [NSNull null],
            @"distRootPath": [weakLoader pluginsDirectory].path ?: [NSNull null],
            @"defaultsOnlySlot": @":defaults",
        }};
    };

    bridgeHandlers()[@"valenced.plugins.list"] = ^NSDictionary *(NSArray *args) {
        PluginLoader *loader = weakLoader;
        NSDictionary *sources = SourcesStoreAll();
        NSMutableArray *payload = [NSMutableArray array];
        for (PluginRecord *record in loader.listableRecords) {
            NSString *id = record.manifest.id;
            if (!record.hasSource && sources[id]) {
                record.hasSource = YES;
                PluginSource *source = sources[id];
                record.sourceRepo = source.repo;
                record.sourceChannel = source.channel ?: REPO_CHANNEL_LATEST;
            }
            [payload addObject:[record toJSPayloadWithScript:YES]];
        }
        return @{@"result": payload};
    };

    bridgeHandlers()[@"valenced.plugins.uninstall"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        if (!pluginId) return @{@"error": @"Expected a plugin ID"};
        PluginRecord *record = [weakLoader records][pluginId];
        if (record && record.isInternal) {
            return @{@"error": [NSString stringWithFormat:@"Plugin %@ is internal and cannot be uninstalled", pluginId]};
        }
        if ([weakLoader isEssentialPlugin:pluginId]) {
            return @{@"error": [NSString stringWithFormat:@"Plugin %@ is essential and cannot be disabled", pluginId]};
        }
        [weakLoader uninstall:pluginId];
        return @{@"result": @{@"restored": [NSNull null]}};
    };

    bridgeHandlers()[@"valenced.plugins.setEnabled"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        BOOL enabled = argBool(args, 1, NO);
        BOOL requiredByUser = argBool(args, 2, NO);
        if (!pluginId) return @{@"error": @"Expected a plugin ID and enabled flag"};
        if (!enabled && [weakLoader isEssentialPlugin:pluginId]) {
            return @{@"error": [NSString stringWithFormat:@"Plugin %@ is essential and cannot be disabled", pluginId]};
        }
        if (enabled) {
            NSArray *problems = [weakLoader dependencyProblemsForPlugin:pluginId];
            if (problems.count > 0) {
                return @{@"error": @{
                    @"code": @"DEPENDENCIES_UNSATISFIED",
                    @"message": [NSString stringWithFormat:@"Plugin %@ has unsatisfied dependencies", pluginId],
                    @"details": @{@"problems": problems},
                }};
            }
        }
        [weakLoader setEnabled:pluginId enabled:enabled requiredByUser:requiredByUser];
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.stop"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        if (!pluginId) return @{@"error": @"Expected a plugin ID"};
        [weakLoader stopNativePlugin:pluginId];
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.restart"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        if (!pluginId) return @{@"error": @"Expected a plugin ID"};
        [weakLoader stopNativePlugin:pluginId];
        if (![weakLoader startNative:pluginId]) {
            return @{@"error": @{
                @"code": @"LOAD_FAILED",
                @"message": [NSString stringWithFormat:@"Failed to restart plugin %@", pluginId],
            }};
        }
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.installFile"] = ^NSDictionary *(NSArray *args) {
        [weakLoader presentFilePickerForInstall];
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.confirmInstallFile"] = ^NSDictionary *(NSArray *args) {
        NSString *token = argString(args, 0, nil);
        BOOL accepted = argBool(args, 1, NO);
        if (!token) return @{@"error": @"Expected an install token"};
        NSString *result = [weakLoader confirmPendingInstall:token accepted:accepted];
        return @{@"result": result ?: @"cancelled"};
    };

    bridgeHandlers()[@"valenced.plugins.planInstall"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        id options = argPresent(args, 1);
        if (!pluginId) return @{@"error": @"Expected a plugin ID"};

        NSDictionary *optionsDict = (options && [options isKindOfClass:[NSDictionary class]]) ? options : @{};
        NSData *optionsData = [NSJSONSerialization dataWithJSONObject:optionsDict options:0 error:nil];
        NSString *optionsJson = optionsData ? [[NSString alloc] initWithData:optionsData encoding:NSUTF8StringEncoding] : @"{}";

        NSMutableDictionary *installed = [NSMutableDictionary dictionary];
        NSMutableDictionary *installedDeps = [NSMutableDictionary dictionary];
        for (NSString *recordKey in [weakLoader records].allKeys) {
            PluginRecord *record = [weakLoader records][recordKey];
            if (record.manifest && record.manifest.version) {
                installed[record.manifest.id] = record.manifest.version.stringValue;
            }
            if (record.manifest && record.manifest.dependencies) {
                NSMutableDictionary *deps = [NSMutableDictionary dictionary];
                for (NSString *depId in record.manifest.dependencies) {
                    PluginDependency *dep = record.manifest.dependencies[depId];
                    NSString *range = dep.versionRange.stringValue;
                    if (range) deps[depId] = range;
                }
                if (deps.count > 0) installedDeps[record.manifest.id] = deps;
            }
        }
        NSData *installedData = [NSJSONSerialization dataWithJSONObject:installed options:0 error:nil];
        NSString *installedJson = installedData ? [[NSString alloc] initWithData:installedData encoding:NSUTF8StringEncoding] : @"{}";
        NSData *depsData = [NSJSONSerialization dataWithJSONObject:installedDeps options:0 error:nil];
        NSString *depsJson = depsData ? [[NSString alloc] initWithData:depsData encoding:NSUTF8StringEncoding] : @"{}";

        char *error = NULL;
        char *planJson = ValencedCore_ResolveInstall(pluginId.UTF8String, optionsJson.UTF8String, installedJson.UTF8String, depsJson.UTF8String, &error);
        if (!planJson) return @{@"error": ValencedCore_ConsumeError(error)};

        NSDictionary *plan = ParseJSONObjectOrEmpty(ValencedCore_ConsumeString(planJson));
        return @{@"result": plan};
    };

    bridgeHandlers()[@"valenced.plugins.install"] = ^NSDictionary *(NSArray *args) {
        id plan = argPresent(args, 0);
        if (![plan isKindOfClass:[NSDictionary class]]) return @{@"error": @"Expected an install plan"};
        NSDictionary *result = ExecuteInstallPlan(plan, ^BOOL(NSString *pluginId) {
            return [weakLoader records][pluginId] != nil;
        }, ^BOOL(NSString *pluginId) {
            PluginRecord *record = [weakLoader records][pluginId];
            return [record isPendingReload] || [weakLoader pendingUpdateForPlugin:pluginId] != nil;
        }, ^(NSString *pluginId, NSString *version) {
            [weakLoader setPendingUpdate:pluginId version:version];
        });
        if (result[@"error"]) return @{@"error": result[@"error"]};
        EmitJSEvent(EVENT_DEPENDENCIES_UPDATED, @{});
        return @{@"result": result};
    };

    bridgeHandlers()[@"valenced.plugins.setHeld"] = ^NSDictionary *(NSArray *args) {
        NSString *pluginId = argString(args, 0, nil);
        id heldValue = argPresent(args, 1);
        if (!pluginId || ![heldValue isKindOfClass:[NSNumber class]]) {
            return @{@"error": @"Expected a plugin ID and boolean"};
        }

        PluginRecord *record = [weakLoader records][pluginId];
        if (!record) return @{@"error": [NSString stringWithFormat:@"Unknown plugin: '%@'", pluginId]};
        if (record.isInternal && !SourcesStoreAll()[pluginId]) {
            return @{@"error": [NSString stringWithFormat:@"Plugin %@ is internal and updates with Valenced itself", pluginId]};
        }
        char *error = NULL;
        char *sourceJson = ValencedCore_SourcesStoreSetHeld(pluginId.UTF8String, [heldValue boolValue] ? 1 : 0, &error);
        if (!sourceJson) return @{@"error": ValencedCore_ConsumeError(error)};
        id source = ParseJSONObjectOrEmpty(ValencedCore_ConsumeString(sourceJson));
        return @{@"result": source};
    };

    bridgeHandlers()[@"valenced.plugins.listUpdates"] = ^NSDictionary *(NSArray *args) {
        NSMutableDictionary *installed = [NSMutableDictionary dictionary];
        NSMutableDictionary *pending = [NSMutableDictionary dictionary];
        NSMutableDictionary *installedDeps = [NSMutableDictionary dictionary];
        NSDictionary *allRecords = [weakLoader records];
        for (NSString *recordKey in allRecords.allKeys) {
            PluginRecord *record = allRecords[recordKey];
            if (record.manifest && record.manifest.version) {
                installed[record.manifest.id] = record.manifest.version.stringValue;
            }

            NSString *pendingVersion = [weakLoader pendingUpdateForPlugin:record.manifest.id];
            if (pendingVersion) pending[record.manifest.id] = pendingVersion;
            if (record.manifest.dependencies) {
                NSMutableDictionary *deps = [NSMutableDictionary dictionary];
                for (NSString *depId in record.manifest.dependencies) {
                    PluginDependency *dep = record.manifest.dependencies[depId];
                    NSString *range = dep.versionRange.stringValue;
                    if (range) deps[depId] = range;
                }
                if (deps.count > 0) installedDeps[record.manifest.id] = deps;
            }
        }
        NSData *installedData = [NSJSONSerialization dataWithJSONObject:installed options:0 error:nil];
        NSString *installedJson = installedData ? [[NSString alloc] initWithData:installedData encoding:NSUTF8StringEncoding] : @"{}";
        NSData *pendingData = [NSJSONSerialization dataWithJSONObject:pending options:0 error:nil];
        NSString *pendingJson = pendingData ? [[NSString alloc] initWithData:pendingData encoding:NSUTF8StringEncoding] : @"{}";
        NSData *depsData = [NSJSONSerialization dataWithJSONObject:installedDeps options:0 error:nil];
        NSString *depsJson = depsData ? [[NSString alloc] initWithData:depsData encoding:NSUTF8StringEncoding] : @"{}";

        char *error = NULL;
        char *updatesJson = ValencedCore_FindUpdates(installedJson.UTF8String, pendingJson.UTF8String, depsJson.UTF8String, &error);
        if (!updatesJson) return @{@"error": ValencedCore_ConsumeError(error)};

        id updates = ParseJSONObjectOrEmpty(ValencedCore_ConsumeString(updatesJson));
        return @{@"result": updates};
    };
}

extern "C" void RegisterPluginLoaderMethods(void) {
    [[PluginLoader sharedLoader] registerLoaderMethods];
}

@end

#pragma clang diagnostic pop
