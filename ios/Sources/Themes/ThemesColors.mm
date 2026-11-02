#import "Themes.h"

#import <objc/message.h>
#import <objc/runtime.h>

#import "Logger.h"

NS_ASSUME_NONNULL_BEGIN

static NSString *baseForThemeIndex(NSInteger index) {
    switch (index) {
        case 1: return VTHThemeBaseLight;
        case 2: return VTHThemeBaseMidnight;
        case 3: return VTHThemeBaseDarker;
        case 0:
        default: return VTHThemeBaseDark;
    }
}

static NSString *_Nullable suffixForBase(NSString *base) {
    if ([base isEqualToString:VTHThemeBaseDark]) return @"ash";
    if ([base isEqualToString:VTHThemeBaseDarker]) return @"dark";
    if ([base isEqualToString:VTHThemeBaseLight]) return @"light";
    if ([base isEqualToString:VTHThemeBaseMidnight]) return @"onyx";
    return nil;
}

static NSString *VTHLowercase(NSString *value) {
    static NSLocale *locale;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    });
    return [value lowercaseStringWithLocale:locale];
}

static NSInteger currentThemeIndex(void) {
    Class manager = objc_getClass("DCDThemeManager");
    SEL selector = NSSelectorFromString(@"theme");
    if (!manager || ![manager respondsToSelector:selector]) return 0;
    return ((NSInteger (*)(id, SEL))objc_msgSend)(manager, selector);
}

static void VTHRefreshView(UIView *view) {
    [view setNeedsDisplay];
    [view setNeedsLayout];
    for (UIView *subview in view.subviews) VTHRefreshView(subview);
}

@implementation VTHColorApplier {
    NSDictionary<NSString *, UIColor *> *_resources;

    NSMutableDictionary<NSString *, NSValue *> *_semanticOriginals;
    NSValue *_namedColorOriginal;
    NSValue *_namedColorLongOriginal;
    BOOL _semanticInstalled;
    BOOL _namedColorInstalled;

    NSMutableSet<NSString *> *_logged;
}

+ (instancetype)sharedApplier {
    static VTHColorApplier *applier;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ applier = [[VTHColorApplier alloc] init]; });
    return applier;
}

- (instancetype)init {
    if ((self = [super init])) {
        _semanticOriginals = [NSMutableDictionary dictionary];
        _logged = [NSMutableSet set];
    }
    return self;
}

- (nullable UIColor *)_colorFromHex:(NSString *)hex {
    if (![hex isKindOfClass:[NSString class]] || ![hex hasPrefix:@"#"]) return nil;

    NSUInteger digits = hex.length - 1;
    if (digits != 3 && digits != 4 && digits != 6 && digits != 8) return nil;

    unsigned long long value = 0;
    NSScanner *scanner = [NSScanner scannerWithString:hex];
    [scanner setScanLocation:1];
    if (![scanner scanHexLongLong:&value] || !scanner.isAtEnd) return nil;

    if (digits == 3 || digits == 4) {
        CGFloat r = ((value >> (digits == 3 ? 8 : 12)) & 0xF) / 15.0;
        CGFloat g = ((value >> (digits == 3 ? 4 : 8)) & 0xF) / 15.0;
        CGFloat b = ((value >> (digits == 3 ? 0 : 4)) & 0xF) / 15.0;
        CGFloat a = digits == 4 ? (value & 0xF) / 15.0 : 1.0;
        return [UIColor colorWithRed:r green:g blue:b alpha:a];
    }
    if (digits == 6) {
        return [UIColor colorWithRed:((value & 0xFF0000) >> 16) / 255.0
                               green:((value & 0xFF00) >> 8) / 255.0
                                blue:(value & 0xFF) / 255.0
                               alpha:1.0];
    }
    if (digits == 8) {
        return [UIColor colorWithRed:((value & 0xFF000000) >> 24) / 255.0
                               green:((value & 0xFF0000) >> 16) / 255.0
                                blue:((value & 0xFF00) >> 8) / 255.0
                               alpha:(value & 0xFF) / 255.0];
    }
    return nil;
}

- (NSString *)_camelToSnake:(NSString *)input {
    NSMutableString *output = [NSMutableString string];
    NSCharacterSet *uppercase = [NSCharacterSet uppercaseLetterCharacterSet];
    for (NSUInteger i = 0; i < input.length; i++) {
        unichar c = [input characterAtIndex:i];
        if (i > 0 && [uppercase characterIsMember:c]) [output appendString:@"_"];
        [output appendFormat:@"%c", toupper(c)];
    }
    return output;
}

- (void)_logOnce:(NSString *)key message:(NSString *)message {
    @synchronized(self) {
        if ([_logged containsObject:key]) return;
        [_logged addObject:key];
        ValencedLog(@"Themes: applied %@ %@", message, key);
    }
}

- (nullable UIColor *)_colorForKey:(NSString *)key {
    if (![key isKindOfClass:[NSString class]]) return nil;
    NSDictionary<NSString *, UIColor *> *resources;
    @synchronized(self) { resources = _resources; }
    return resources[key];
}

- (nullable UIColor *)_colorForResourceName:(NSString *)name {
    if (![name isKindOfClass:[NSString class]]) return nil;
    NSString *key = VTHLowercase(name);
    UIColor *color = [self _colorForKey:key];
    if (color) return color;

    NSString *suffix = suffixForBase(baseForThemeIndex(currentThemeIndex()));
    if (!suffix) return nil;
    return [self _colorForKey:[NSString stringWithFormat:@"%@_%@", key, suffix]];
}

- (nullable UIColor *)_colorForSemanticName:(NSString *)name {
    if (![name isKindOfClass:[NSString class]]) return nil;
    NSString *key = VTHLowercase(name);

    NSString *suffix = suffixForBase(baseForThemeIndex(currentThemeIndex()));
    if (suffix) {
        UIColor *color = [self _colorForKey:[NSString stringWithFormat:@"%@_%@", key, suffix]];
        if (color) return color;
    }
    return [self _colorForKey:key];
}

- (NSDictionary<NSString *, UIColor *> *)_buildResources:(VTHColorsSelection *)selection {
    NSMutableDictionary<NSString *, UIColor *> *resources = [NSMutableDictionary dictionary];

    for (NSString *name in selection.raw.byName) {
        UIColor *color = [self _colorFromHex:selection.raw.byName[name]];
        if (color) resources[VTHLowercase(name)] = color;
    }

    for (NSString *base in selection.semantic.byBase) {
        NSString *suffix = suffixForBase(base);
        if (!suffix) continue;

        NSDictionary<NSString *, NSString *> *values = selection.semantic.byBase[base];
        for (NSString *name in values) {
            UIColor *color = [self _colorFromHex:values[name]];
            if (!color) continue;
            NSString *key = [NSString stringWithFormat:@"%@_%@", VTHLowercase(name), suffix];
            resources[key] = color;
        }
    }

    return resources;
}

- (BOOL)_installSemanticColors {
    Class target = objc_getClass("DCDThemeColor");
    if (!target) return NO;

    unsigned int count = 0;
    Method *methods = class_copyMethodList(object_getClass(target), &count);
    if (!methods) return NO;

    unsigned int swizzled = 0;
    for (unsigned int i = 0; i < count; i++) {
        Method method = methods[i];
        char rtype[256];
        method_getReturnType(method, rtype, sizeof(rtype));
        if (strcmp(rtype, @encode(UIColor *)) != 0) continue;
        if (method_getNumberOfArguments(method) != 2) continue;

        SEL selector = method_getName(method);
        NSString *name = NSStringFromSelector(selector);
        NSString *snake = [self _camelToSnake:name];
        IMP original = method_getImplementation(method);
        _semanticOriginals[name] = [NSValue valueWithPointer:(void *)original];

        IMP replacement = imp_implementationWithBlock(^UIColor *(id self) {
            VTHColorApplier *applier = [VTHColorApplier sharedApplier];
            UIColor *color = [applier _colorForSemanticName:snake];
            if (color) {
                [applier _logOnce:name message:@"theme color"];
                return color;
            }
            return ((UIColor * (*)(id, SEL))original)(self, selector);
        });
        method_setImplementation(method, replacement);
        swizzled++;
    }
    free(methods);
    return swizzled > 0;
}

- (BOOL)_installNamedColors {
    Class target = [UIColor class];
    BOOL installed = NO;

    SEL shortSelector = NSSelectorFromString(@"colorNamed:");
    Method shortMethod = class_getClassMethod(target, shortSelector);
    if (shortMethod) {
        IMP original = method_getImplementation(shortMethod);
        _namedColorOriginal = [NSValue valueWithPointer:(void *)original];

        IMP replacement = imp_implementationWithBlock(^UIColor *(id self, NSString *name) {
            VTHColorApplier *applier = [VTHColorApplier sharedApplier];
            UIColor *color = [applier _colorForResourceName:name];
            if (color) {
                [applier _logOnce:name message:@"named color"];
                return color;
            }
            return ((UIColor * (*)(id, SEL, NSString *))original)(self, shortSelector, name);
        });
        method_setImplementation(shortMethod, replacement);
        installed = YES;
    }

    SEL longSelector = NSSelectorFromString(@"colorNamed:inBundle:compatibleWithTraitCollection:");
    Method longMethod = class_getClassMethod(target, longSelector);
    if (longMethod) {
        IMP original = method_getImplementation(longMethod);
        _namedColorLongOriginal = [NSValue valueWithPointer:(void *)original];

        IMP replacement = imp_implementationWithBlock(
            ^UIColor *(id self, NSString *name, NSBundle *bundle, UITraitCollection *traits) {
                VTHColorApplier *applier = [VTHColorApplier sharedApplier];
                UIColor *color = [applier _colorForResourceName:name];
                if (color) {
                    [applier _logOnce:name message:@"named color"];
                    return color;
                }
                return ((UIColor * (*)(id, SEL, NSString *, NSBundle *, UITraitCollection *))original)(
                    self, longSelector, name, bundle, traits);
            });
        method_setImplementation(longMethod, replacement);
        installed = YES;
    }

    return installed;
}

- (void)_clearThemeCache {
    Class manager = objc_getClass("DCDThemeManager");
    SEL selector = NSSelectorFromString(@"clearThemeCache");
    if (manager && [manager respondsToSelector:selector])
        ((void (*)(id, SEL))objc_msgSend)(manager, selector);
}

- (void)_refreshThemedViews {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self _refreshThemedViews]; });
        return;
    }

    UIApplication *application = [UIApplication sharedApplication];
    if (application.applicationState != UIApplicationStateActive) return;

    for (UIScene *scene in application.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) VTHRefreshView(window);
    }
}

- (void)apply:(nullable VTHColorsSelection *)selection {
    @synchronized(self) {
        [_logged removeAllObjects];
        _resources = nil;

        if (selection) {
            NSDictionary<NSString *, UIColor *> *resources = [self _buildResources:selection];
            if (resources.count > 0) {
                _resources = resources;

                if (!_semanticInstalled) _semanticInstalled = [self _installSemanticColors];
                if (!_namedColorInstalled) _namedColorInstalled = [self _installNamedColors];

                ValencedLog(@"Themes: applied %lu color resources (semantic=%d named=%d)",
                            (unsigned long)resources.count, _semanticInstalled, _namedColorInstalled);
            }
        }
    }

    [self _clearThemeCache];
    [self _refreshThemedViews];
}

@end

NS_ASSUME_NONNULL_END
