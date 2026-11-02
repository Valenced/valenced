#import "Themes.h"

#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <objc/runtime.h>

#import "Logger.h"

NS_ASSUME_NONNULL_BEGIN

static const int VTHDefaultFontWeight = 400;

@interface VTHFontApplier ()
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSArray<NSString *> *> *postScriptsByName;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSArray<VTHFontVariant *> *> *variantsByName;
@property (nonatomic, assign) IMP fontWithNameOriginal;
@property (nonatomic, assign) IMP fontWithDescriptorOriginal;
- (void)installHooks;
- (void)installHooksOnce;
- (UIFont *)fontWithPostScript:(NSString *)postScript cascade:(nullable NSArray *)cascade size:(CGFloat)size;
@end

static NSString *_Nullable VTHRegisterFontFile(NSString *path) {
    if (path.length == 0 || ![[NSFileManager defaultManager] fileExistsAtPath:path]) return nil;

    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;

    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    if (!provider) return nil;
    CGFontRef font = CGFontCreateWithDataProvider(provider);
    if (!font) {
        CGDataProviderRelease(provider);
        return nil;
    }

    NSString *postScript = nil;
    CFStringRef ps = CGFontCopyPostScriptName(font);
    if (ps) {
        postScript = (__bridge_transfer NSString *)ps;

        CTFontRef existing = CTFontCreateWithName((__bridge CFStringRef)postScript, 0, NULL);
        if (existing) {
            CTFontManagerUnregisterGraphicsFont(font, NULL);
            CFRelease(existing);
        }

        CFErrorRef error = NULL;
        if (!CTFontManagerRegisterGraphicsFont(font, &error)) {
            ValencedLog(@"Themes: failed to register font %@", path);
            if (error) CFRelease(error);
        }
    }

    CGFontRelease(font);
    CGDataProviderRelease(provider);
    return postScript;
}

@implementation VTHFontApplier

+ (instancetype)sharedApplier {
    static VTHFontApplier *applier;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ applier = [[VTHFontApplier alloc] init]; });
    return applier;
}

- (instancetype)init {
    if ((self = [super init])) {
        _variantsByName = [NSMutableDictionary dictionary];
        _postScriptsByName = [NSMutableDictionary dictionary];
        [self installHooks];
    }
    return self;
}

static NSUInteger VTHClosestVariantIndex(NSArray<VTHFontVariant *> *variants, int weight, BOOL italic) {
    NSUInteger best = 0;
    long bestScore = LONG_MAX;
    for (NSUInteger i = 0; i < variants.count; i++) {
        VTHFontVariant *variant = variants[i];
        long score = (variant.italic == italic ? 0 : 1000000)
                   + labs((long)variant.weight - (long)weight) * 10
                   - variant.weight;
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    }
    return best;
}

- (nullable NSString *)postScriptForName:(NSString *)name weight:(int)weight italic:(BOOL)italic {
    if (name.length == 0) return nil;
    NSArray<NSString *> *postScripts = _postScriptsByName[name];
    NSArray<VTHFontVariant *> *variants = _variantsByName[name];
    if (postScripts.count == 0 || variants.count != postScripts.count) return nil;
    return postScripts[VTHClosestVariantIndex(variants, weight, italic)];
}

#pragma mark - Application

- (UIFont *)fontWithPostScript:(NSString *)postScript cascade:(nullable NSArray *)cascade size:(CGFloat)size {
    UIFontDescriptor *replacement = [UIFontDescriptor fontDescriptorWithName:postScript size:size];
    if (!cascade.count) return ((UIFont * (*)(id, SEL, UIFontDescriptor *, CGFloat))self.fontWithDescriptorOriginal)([UIFont class], @selector(fontWithDescriptor:size:), replacement, size);

    UIFontDescriptor *final = [replacement fontDescriptorByAddingAttributes:@{
        UIFontDescriptorCascadeListAttribute: cascade }];
    return ((UIFont * (*)(id, SEL, UIFontDescriptor *, CGFloat))self.fontWithDescriptorOriginal)([UIFont class], @selector(fontWithDescriptor:size:), final, size);
}

- (void)apply:(nullable VTHFontsSelection *)selection {
    @synchronized(self) {
        [_variantsByName removeAllObjects];
        [_postScriptsByName removeAllObjects];
        if (!selection) return;

        for (NSString *family in selection.sources) {
            VTHFontSource *source = selection.sources[family];
            if (source.variants.count == 0) continue;

            NSMutableArray<NSString *> *postScripts = [NSMutableArray array];
            NSMutableArray<VTHFontVariant *> *variants = [NSMutableArray array];
            for (VTHFontVariant *variant in source.variants) {
                NSString *ps = VTHRegisterFontFile(variant.path);
                if (!ps) {
                    ValencedLog(@"Themes: font file missing for %@: %@", family, variant.path);
                    continue;
                }
                [postScripts addObject:ps];
                [variants addObject:variant];
            }
            if (postScripts.count) {
                _postScriptsByName[family] = postScripts;
                _variantsByName[family] = variants;
            }
        }
        ValencedLog(@"Themes: applied %lu font families", (unsigned long)_postScriptsByName.count);
    }
}

- (void)registerPreviewFamily:(NSString *)name variants:(NSArray<VTHFontVariant *> *)variants {
    @synchronized(self) {
        NSMutableArray<NSString *> *postScripts = [NSMutableArray arrayWithCapacity:variants.count];
        NSMutableArray<VTHFontVariant *> *kept = [NSMutableArray arrayWithCapacity:variants.count];
        for (VTHFontVariant *variant in variants) {
            NSString *ps = VTHRegisterFontFile(variant.path);
            if (!ps) continue;
            [postScripts addObject:ps];
            [kept addObject:variant];
        }
        if (postScripts.count) {
            _postScriptsByName[name] = postScripts;
            _variantsByName[name] = kept;
        }
    }
}

- (void)installHooks {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [self installHooksOnce];
    });
}

- (void)installHooksOnce {
    Class cls = [UIFont class];

    SEL nameSel = @selector(fontWithName:size:);
    Method nameMethod = class_getClassMethod(cls, nameSel);
    IMP nameOriginal = method_getImplementation(nameMethod);
    self.fontWithNameOriginal = nameOriginal;
    IMP nameReplacement = imp_implementationWithBlock(^UIFont *(id self, NSString *name, CGFloat size) {
        VTHFontApplier *applier = [VTHFontApplier sharedApplier];
        NSString *postScript = [applier postScriptForName:name weight:VTHDefaultFontWeight italic:NO];
        if (postScript) {
            NSArray *cascade = @[ [UIFontDescriptor fontDescriptorWithName:name size:size] ];
            return [applier fontWithPostScript:postScript cascade:cascade size:size];
        }
        return ((UIFont * (*)(id, SEL, NSString *, CGFloat))nameOriginal)(self, nameSel, name, size);
    });
    method_setImplementation(nameMethod, nameReplacement);

    SEL descSel = @selector(fontWithDescriptor:size:);
    Method descMethod = class_getClassMethod(cls, descSel);
    IMP descOriginal = method_getImplementation(descMethod);
    self.fontWithDescriptorOriginal = descOriginal;
    IMP descReplacement = imp_implementationWithBlock(^UIFont *(id self, UIFontDescriptor *descriptor, CGFloat size) {
        int weight = 400;
        BOOL italic = NO;
        NSDictionary *traits = descriptor.fontAttributes[UIFontDescriptorTraitsAttribute];
        NSNumber *weightValue = traits[UIFontWeightTrait];
        if ([weightValue isKindOfClass:[NSNumber class]])
            weight = (int)(weightValue.doubleValue * 400.0 + 400.0);
        NSNumber *slant = traits[UIFontSlantTrait];
        if ([slant isKindOfClass:[NSNumber class]]) italic = slant.doubleValue > 0;

        VTHFontApplier *applier = [VTHFontApplier sharedApplier];
        NSString *postScript = [applier postScriptForName:descriptor.postscriptName weight:weight italic:italic];
        if (!postScript) {
            id family = descriptor.fontAttributes[UIFontDescriptorNameAttribute];
            if ([family isKindOfClass:[NSString class]])
                postScript = [applier postScriptForName:family weight:weight italic:italic];
        }
        if (postScript) return [applier fontWithPostScript:postScript cascade:@[ descriptor ] size:size];
        return ((UIFont * (*)(id, SEL, UIFontDescriptor *, CGFloat))descOriginal)(self, descSel, descriptor, size);
    });
    method_setImplementation(descMethod, descReplacement);

    SEL systemSel = @selector(systemFontOfSize:);
    Method systemMethod = class_getClassMethod(cls, systemSel);
    IMP systemOriginal = method_getImplementation(systemMethod);
    IMP systemReplacement = imp_implementationWithBlock(^UIFont *(id self, CGFloat size) {
        VTHFontApplier *applier = [VTHFontApplier sharedApplier];
        NSString *postScript = [applier postScriptForName:@"systemFont" weight:VTHDefaultFontWeight italic:NO];
        if (postScript) return [applier fontWithPostScript:postScript cascade:nil size:size];
        return ((UIFont * (*)(id, SEL, CGFloat))systemOriginal)(self, systemSel, size);
    });
    method_setImplementation(systemMethod, systemReplacement);

    SEL preferredSel = @selector(preferredFontForTextStyle:);
    Method preferredMethod = class_getClassMethod(cls, preferredSel);
    IMP preferredOriginal = method_getImplementation(preferredMethod);
    IMP preferredReplacement = imp_implementationWithBlock(^UIFont *(id self, UIFontTextStyle style) {
        VTHFontApplier *applier = [VTHFontApplier sharedApplier];
        NSString *postScript = [applier postScriptForName:@"systemFont" weight:VTHDefaultFontWeight italic:NO];
        if (postScript) return [applier fontWithPostScript:postScript cascade:nil size:[UIFont systemFontSize]];
        return ((UIFont * (*)(id, SEL, UIFontTextStyle))preferredOriginal)(self, preferredSel, style);
    });
    method_setImplementation(preferredMethod, preferredReplacement);
}

@end

NS_ASSUME_NONNULL_END
