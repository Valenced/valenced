#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <jsi/jsi.h>
#import <functional>
#import <unistd.h>
#import <dlfcn.h>
#import <objc/runtime.h>

#import "Bridge.h"
#import "Updater.h"
#import "Logger.h"
#import "Utils.h"
#import "RCTHost.h"
#import "RCTInstance.h"
#import "Constants.h"
#import "Plugins/PluginLoader.h"

using namespace facebook;

@interface RCTSource : NSObject
@property (nonatomic, strong) NSURL *url;
@property (nonatomic, strong) NSData *data;
@end

static NSTimeInterval shakeStartTime = 0;
static BOOL           isShaking      = NO;
static BOOL           gScriptsInjected = NO;

// The bundle shipped next to the tweak, built by the :bundle Gradle project.
static NSData *loadShippedBundle(void)
{
    NSData *embedded = ValencedEmbeddedSection("__vbundle");
    if (embedded.length > 0) {
        ValencedLog(@"Using embedded bundle (%lu bytes)", (unsigned long)embedded.length);
        return embedded;
    }
    NSMutableArray<NSBundle *> *bundles = [NSMutableArray array];
    NSBundle *classBundle = [NSBundle bundleForClass:[PluginLoader class]];
    if (classBundle) [bundles addObject:classBundle];
    NSBundle *mainBundle = [NSBundle mainBundle];
    if (mainBundle) [bundles addObject:mainBundle];
    NSBundle *identifierBundle = [NSBundle bundleWithIdentifier:@"app.valenced.tweak"];
    if (identifierBundle) [bundles addObject:identifierBundle];
    for (NSBundle *b in bundles) {
        NSString *path = [b pathForResource:@"valenced" ofType:@"bundle"];
        if (path) {
            NSData *d = [NSData dataWithContentsOfFile:path];
            if (d.length > 0) {
                ValencedLog(@"Using fallback bundle at %@", path);
                return d;
            }
        }
    }
    Dl_info info;
    if (dladdr((void *)&loadShippedBundle, &info) && info.dli_fname) {
        NSString *dylibPath = [NSString stringWithUTF8String:info.dli_fname];
        NSString *dir = [dylibPath stringByDeletingLastPathComponent];
        NSString *p = [dir stringByAppendingPathComponent:@"valenced.bundle"];
        NSData *d = [NSData dataWithContentsOfFile:p];
        if (d.length > 0) {
            ValencedLog(@"Using fallback bundle at %@", p);
            return d;
        }
    }
    return nil;
}

static NSURL *materializeEmbeddedBundle(NSData *bundle)
{
    if (bundle.length == 0) return nil;
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *cacheDir = [getValencedDirectory() URLByAppendingPathComponent:CACHE_DIR];
    [fm createDirectoryAtURL:cacheDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *fileURL = [cacheDir URLByAppendingPathComponent:@"valenced.embedded.bundle"];
    NSError *error = nil;
    if (![bundle writeToURL:fileURL options:NSDataWritingAtomic error:&error]) {
        ValencedLog(@"Failed to materialize embedded bundle: %@", error);
        return nil;
    }
    return fileURL;
}

static id makeRCTSource(NSURL *url, NSData *data)
{
    if (!url || data.length == 0) return nil;
    Class cls = NSClassFromString(@"RCTSource");
    if (!cls) return nil;
    id source = [[cls alloc] init];
    @try {
        [source setValue:url forKey:@"url"];
        [source setValue:data forKey:@"data"];
    } @catch (NSException *e) {
        ValencedLog(@"Failed to construct RCTSource: %@ %@", e.name, e.reason);
        return nil;
    }
    return source;
}

static void loadScriptSource(id instance, NSURL *url, NSData *data)
{
    if (!instance || !url || data.length == 0) return;
    id source = makeRCTSource(url, data);
    if (!source) {
        ValencedLog(@"Failed to create RCTSource for %@", url.lastPathComponent ?: url.absoluteString);
        return;
    }
    if (![instance respondsToSelector:@selector(_loadScriptFromSource:)]) {
        ValencedLog(@"RCTInstance does not respond to _loadScriptFromSource:");
        return;
    }
    [instance _loadScriptFromSource:source];
}

#ifdef DEBUG
static void injectPreloads(id instance, NSURL *valencedDir)
{
    NSURL *preloadsDirectory = [valencedDir URLByAppendingPathComponent:PRELOADS_DIR];
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:preloadsDirectory.path]) return;

    NSArray<NSURL *> *contents = [fm contentsOfDirectoryAtURL:preloadsDirectory
                                   includingPropertiesForKeys:nil options:0 error:nil];
    NSArray *sorted = [contents sortedArrayUsingComparator:^NSComparisonResult(NSURL *a, NSURL *b) {
        return [a.path caseInsensitiveCompare:b.path];
    }];
    for (NSURL *fileURL in sorted)
    {
        BOOL isDir = NO;
        if ([fm fileExistsAtPath:fileURL.path isDirectory:&isDir] && !isDir)
        {
            NSData *data = [NSData dataWithContentsOfURL:fileURL];
            if (data.length > 0) {
                ValencedLog(@"Running preload: %@", fileURL.lastPathComponent);
                loadScriptSource(instance, fileURL, data);
            }
        }
    }
}
#endif

static void injectValencedScripts(id instance)
{
    @try {
        NSURL *bundleURL = nil;
        NSData *bundleData = nil;

#ifdef DEBUG
        injectPreloads(instance, getValencedDirectory());
        Updater *updater = [Updater sharedUpdater];
        if ([updater resolveDownloadURL]) {
            NSURL *devBundleURL = [updater bundleFile];
            NSData *devBundle = devBundleURL ? [NSData dataWithContentsOfURL:devBundleURL] : nil;
            if (devBundle.length > 0) {
                ValencedLog(@"Loading development bundle: %@", devBundleURL.path);
                loadScriptSource(instance, devBundleURL, devBundle);
                return;
            }
        }
#endif

        bundleData = loadShippedBundle();
        if (bundleData.length > 0) {
            bundleURL = materializeEmbeddedBundle(bundleData);
            if (!bundleURL) {
                bundleURL = [[getValencedDirectory() URLByAppendingPathComponent:CACHE_DIR]
                    URLByAppendingPathComponent:@"valenced.embedded.bundle"];
            }
            ValencedLog(@"Loading valenced:bundle (%lu bytes)", (unsigned long)bundleData.length);
            loadScriptSource(instance, bundleURL, bundleData);
        } else {
            ValencedLog(@"No bundle available at all");
        }
    } @catch (NSException *e) {
        ValencedLog(@"Valenced script injection exception: %@ %@", e.name, e.reason);
    }
}

%hook RCTHost

- (void)instance:(id)instance didInitializeRuntime:(facebook::jsi::Runtime &)runtime
{
    SetJsiRuntime(&runtime);
    SetJsiInstance(instance);

#ifdef DEBUG
    Updater *updater = [Updater sharedUpdater];
    [updater initConfig];
    if ([updater resolveDownloadURL]) {
        ValencedLog(@"Fetching development bundle...");
        [updater downloadScriptUserInitiated:NO showDialog:NO];
    }
#endif

    @try {
        injectPreBundle(runtime);
    } @catch (NSException *e) {
        ValencedLog(@"injectPreBundle exception: %@ %@", e.name, e.reason);
    }
    @try {
        [[PluginLoader sharedLoader] loadPlugins];
    } @catch (NSException *e) {
        ValencedLog(@"loadPlugins exception: %@ %@", e.name, e.reason);
    }

    %orig;
}

%end

%hook RCTInstance

- (void)_loadScriptFromSource:(id)source
{
    if (gScriptsInjected) {
        %orig;
        return;
    }
    gScriptsInjected = YES;
    ValencedLog(@"Intercepted script load, injecting Valenced before host bundle");
    @try {
        injectValencedScripts(self);
    } @catch (NSException *e) {
        ValencedLog(@"Valenced script injection failed: %@ %@", e.name, e.reason);
    }
    %orig;
    gScriptsInjected = NO;
}

%end

%hook UIWindow

- (void)motionBegan:(UIEventSubtype)motion withEvent:(UIEvent *)event
{
    if (motion == UIEventSubtypeMotionShake)
    {
        isShaking      = YES;
        shakeStartTime = [[NSDate date] timeIntervalSince1970];
    }
    %orig;
}

- (void)motionEnded:(UIEventSubtype)motion withEvent:(UIEvent *)event
{
    if (motion == UIEventSubtypeMotionShake && isShaking)
    {
        NSTimeInterval shakeDuration = [[NSDate date] timeIntervalSince1970] - shakeStartTime;
        if (shakeDuration >= 0.5 && shakeDuration <= 2.0)
            dispatch_async(dispatch_get_main_queue(), ^{ showRecoveryAlert(nil); });
        isShaking = NO;
    }
    %orig;
}

%end

extern "C" void ThemesApplyAtBoot(void);

%ctor
{
    @autoreleasepool
    {
        %init;
        RegisterBridgeMethods();
        ThemesApplyAtBoot();
    }
}
