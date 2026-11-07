#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <jsi/jsi.h>
#import <functional>
#import <unistd.h>
#import <dlfcn.h>

#import "Bridge.h"
#import "Updater.h"
#import "Logger.h"
#import "Utils.h"
#import "JSI.h"
#import "RCTHost.h"
#import "RCTInstance.h"
#import "Constants.h"
#import "Plugins/PluginLoader.h"

using namespace facebook;

static jsi::Runtime *gRuntime = NULL;
static NSTimeInterval shakeStartTime = 0;
static BOOL           isShaking      = NO;

#ifdef DEBUG
static void executePreloads(jsi::Runtime &runtime, NSURL *valencedDir)
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
            if (data) {
                ValencedLog(@"Running preload: %@", fileURL.lastPathComponent);
                [JSI evaluate:data tag:@"valenced:preload" runtime:runtime];
            }
        }
    }
}
#endif

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

%hook RCTHost

- (void)instance:(id)instance didInitializeRuntime:(facebook::jsi::Runtime &)runtime
{
    SetJsiRuntime(&runtime);
    SetJsiInstance(instance);
    gRuntime = &runtime;

#ifdef DEBUG
    // Debug builds can load a development bundle from the custom URL in loader.json.
    Updater *updater = [Updater sharedUpdater];
    [updater initConfig];
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

#ifdef DEBUG
    NSURL *devBundleURL = nil;
    if ([updater resolveDownloadURL]) {
        ValencedLog(@"Fetching development bundle...");
        [updater downloadScriptUserInitiated:NO showDialog:NO];
        devBundleURL = [updater bundleFile];
    }
#endif

    %orig;

    @try {
        NSData *bundle = nil;
        NSString *tag = @"valenced:bundle";
#ifdef DEBUG
        executePreloads(runtime, getValencedDirectory());
        if (devBundleURL) {
            bundle = [NSData dataWithContentsOfURL:devBundleURL];
            tag = @"valenced:bundle:dev";
        }
        if (bundle.length == 0) tag = @"valenced:bundle";
#endif
        if (bundle.length == 0) bundle = loadShippedBundle();

        if (bundle.length > 0) {
            ValencedLog(@"Loading %@ (%lu bytes)", tag, (unsigned long)bundle.length);
            [JSI evaluate:bundle tag:tag runtime:runtime];
        } else {
            ValencedLog(@"No bundle available at all");
        }
    } @catch (NSException *e) {
        ValencedLog(@"sync injection exception: %@ %@", e.name, e.reason);
    }
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
