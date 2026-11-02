#import "Themes.h"

#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <objc/message.h>
#import <objc/runtime.h>

#import "Constants.h"
#import "Logger.h"
#import "Utils.h"

NS_ASSUME_NONNULL_BEGIN

static NSString *const kEmojiAssetPrefix = @"emoji-";
static NSString *const kEmojiAssetSuffix = @".png";
static const CGFloat kEmojiCanvasSize = 128.0;

@interface VTHEmojiApplier ()
- (BOOL)hasSelection;
- (NSUInteger)generation;
- (nullable NSString *)overridePathForEmojiText:(NSString *)text;
- (nullable UIImage *)imageForEmojiText:(NSString *)text;
- (nullable NSData *)pngDataForEmojiText:(NSString *)text size:(CGFloat)size;
@end

static NSString *_Nullable VTHEmojiCodepoints(NSString *assetName) {
    if (![assetName hasPrefix:kEmojiAssetPrefix] || ![assetName hasSuffix:kEmojiAssetSuffix]) return nil;
    NSString *codepoints = [assetName substringWithRange:NSMakeRange(kEmojiAssetPrefix.length,
        assetName.length - kEmojiAssetPrefix.length - kEmojiAssetSuffix.length)];
    static NSRegularExpression *regex;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = [NSRegularExpression regularExpressionWithPattern:@"[0-9a-f]+(-[0-9a-f]+)*" options:0 error:nil];
    });
    NSTextCheckingResult *match = [regex firstMatchInString:codepoints options:0 range:NSMakeRange(0, codepoints.length)];
    if (!match || match.range.length != codepoints.length || codepoints.length == 0) return nil;
    return codepoints;
}

static NSString *_Nullable VTHEmojiCodepointsForText(NSString *text) {
    if (text.length == 0) return nil;

    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    NSUInteger length = text.length;
    unichar *characters = (unichar *)malloc(sizeof(unichar) * length);
    if (!characters) return nil;
    [text getCharacters:characters range:NSMakeRange(0, length)];

    for (NSUInteger i = 0; i < length; i++) {
        uint32_t code = characters[i];
        if (CFStringIsSurrogateHighCharacter((UniChar)code) && i + 1 < length
            && CFStringIsSurrogateLowCharacter(characters[i + 1])) {
            code = (uint32_t)CFStringGetLongCharacterForSurrogatePair((UniChar)code, characters[i + 1]);
            i++;
        }
        [parts addObject:[NSString stringWithFormat:@"%x", code]];
    }
    free(characters);
    return parts.count ? [parts componentsJoinedByString:@"-"] : nil;
}

static NSString *_Nullable VTHEmojiText(NSString *codepoints) {
    NSMutableData *data = [NSMutableData data];
    for (NSString *hex in [codepoints componentsSeparatedByString:@"-"]) {
        unsigned int value = 0;
        NSScanner *scanner = [NSScanner scannerWithString:hex];
        if (![scanner scanHexInt:&value] || value > 0x10FFFF) return nil;
        uint32_t code = (uint32_t)value;
        [data appendBytes:&code length:sizeof(code)];
    }
    return [[NSString alloc] initWithData:data encoding:NSUTF32LittleEndianStringEncoding];
}

static NSArray<NSString *> *VTHEmojiImageNames(NSString *codepoints) {
    NSArray<NSString *> *parts = [codepoints componentsSeparatedByString:@"-"];

    NSMutableArray<NSString *> *variants = [NSMutableArray array];
    void (^addVariant)(NSArray<NSString *> *) = ^(NSArray<NSString *> *components) {
        NSString *joined = [components componentsJoinedByString:@"-"];
        if (joined.length && ![variants containsObject:joined]) [variants addObject:joined];
    };

    addVariant(parts);

    NSMutableArray<NSString *> *noVariation = [NSMutableArray array];
    for (NSString *part in parts)
        if (![part isEqualToString:@"fe0f"]) [noVariation addObject:part];
    addVariant(noVariation);

    NSMutableArray<NSString *> *noTone = [NSMutableArray array];
    for (NSString *part in parts) {
        unsigned int value = 0;
        NSScanner *scanner = [NSScanner scannerWithString:part];
        if (![scanner scanHexInt:&value] || value < 0x1F3FB || value > 0x1F3FF)
            [noTone addObject:part];
    }
    addVariant(noTone);

    NSMutableArray<NSString *> *noToneNoVariation = [NSMutableArray array];
    for (NSString *part in noTone)
        if (![part isEqualToString:@"fe0f"]) [noToneNoVariation addObject:part];
    addVariant(noToneNoVariation);

    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (NSString *variant in variants) {
        NSString *name = [NSString stringWithFormat:@"%@%@%@", kEmojiAssetPrefix, variant, kEmojiAssetSuffix];
        if (![names containsObject:name]) [names addObject:name];
    }
    return names;
}

static NSString *_Nullable VTHEmojiRegisterFont(NSString *path) {
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
        CFErrorRef error = NULL;
        CTFontManagerRegisterGraphicsFont(font, &error);
        if (error) CFRelease(error);
    }
    CGFontRelease(font);
    CGDataProviderRelease(provider);
    return postScript;
}

static NSString *VTHEmojiNormalizeAssetName(NSString *name) {
    NSRange scale = [name rangeOfString:@"@" options:NSBackwardsSearch];
    if (scale.location != NSNotFound) name = [name substringToIndex:scale.location];
    return name;
}

static BOOL VTHStringMayContainNonASCII(NSString *text) {
    if (text.length == 0) return NO;
    for (NSUInteger i = 0; i < text.length; i++)
        if ([text characterAtIndex:i] > 0x7F) return YES;
    return NO;
}

static id _Nullable VTHIvar(id object, const char *name) {
    if (!object) return nil;
    Ivar ivar = class_getInstanceVariable([object class], name);
    return ivar ? object_getIvar(object, ivar) : nil;
}

static UIFont *_Nullable VTHFontForView(id view) {
    if ([view respondsToSelector:@selector(font)])
        return ((UIFont *(*)(id, SEL))objc_msgSend)(view, @selector(font));
    return nil;
}

static UIColor *_Nullable VTHColorForView(id view) {
    if ([view respondsToSelector:@selector(textColor)])
        return ((UIColor *(*)(id, SEL))objc_msgSend)(view, @selector(textColor));
    return nil;
}

static NSAttributedString *VTHPlainAttributedString(NSString *text, UIFont *_Nullable font,
                                                    UIColor *_Nullable color) {
    NSMutableDictionary<NSAttributedStringKey, id> *attributes = [NSMutableDictionary dictionary];
    if (font) attributes[NSFontAttributeName] = font;
    if (color) attributes[NSForegroundColorAttributeName] = color;
    return [[NSAttributedString alloc] initWithString:text ?: @"" attributes:attributes];
}

static NSAttributedString *VTHEmojiAttachmentString(UIImage *image, UIFont *_Nullable font) {
    NSTextAttachment *attachment = [[NSTextAttachment alloc] init];
    attachment.image = image;

    CGFloat size = font ? font.pointSize : 16.0;
    if (size <= 0) size = 16.0;

    CGSize imageSize = image.size;
    CGFloat width = size;
    CGFloat height = size;
    if (imageSize.width > 0 && imageSize.height > 0) {
        CGFloat ratio = imageSize.width / imageSize.height;
        if (ratio > 1.0) height = size / ratio;
        else if (ratio < 1.0) width = size * ratio;
    }

    attachment.bounds = CGRectMake(0, font ? font.descender : 0, width, height);
    return [NSAttributedString attributedStringWithAttachment:attachment];
}

static NSAttributedString *VTHEmojiTransformOptions(NSAttributedString *text,
                                                    UIFont *_Nullable fallbackFont,
                                                    BOOL requireAll,
                                                    BOOL allowWhitespace) {
    if (text.length == 0 || !VTHStringMayContainNonASCII(text.string)) return text;

    VTHEmojiApplier *applier = [VTHEmojiApplier sharedApplier];
    if (![applier hasSelection]) return text;

    NSMutableAttributedString *result = [[NSMutableAttributedString alloc] init];
    __block BOOL replaced = NO;
    __block BOOL allReplaced = YES;

    [text.string enumerateSubstringsInRange:NSMakeRange(0, text.string.length)
                                    options:NSStringEnumerationByComposedCharacterSequences
                                 usingBlock:^(NSString *_Nullable substring, NSRange substringRange,
                                              NSRange enclosingRange, BOOL *stop) {
        if (substring.length == 0) return;

        UIImage *image = [applier imageForEmojiText:substring];
        if (!image) {
            BOOL whitespace = allowWhitespace
                && [substring rangeOfCharacterFromSet:
                    [NSCharacterSet whitespaceAndNewlineCharacterSet].invertedSet].location == NSNotFound;
            if (!whitespace) allReplaced = NO;
            [result appendAttributedString:[text attributedSubstringFromRange:substringRange]];
            return;
        }

        replaced = YES;
        UIFont *font = [text attribute:NSFontAttributeName atIndex:substringRange.location effectiveRange:NULL]
                    ?: fallbackFont;
        NSMutableAttributedString *attachment = [VTHEmojiAttachmentString(image, font) mutableCopy];
        NSDictionary<NSAttributedStringKey, id> *attributes =
            [text attributesAtIndex:substringRange.location effectiveRange:NULL];
        if (attributes.count) [attachment addAttributes:attributes range:NSMakeRange(0, attachment.length)];
        [result appendAttributedString:attachment];
    }];

    if (!replaced) return text;
    if (requireAll && !allReplaced) return text;
    return result;
}

static NSAttributedString *VTHEmojiTransform(NSAttributedString *text, UIFont *_Nullable fallbackFont,
                                             BOOL requireAll) {
    return VTHEmojiTransformOptions(text, fallbackFont, requireAll, NO);
}

static Class _Nullable VTHYYLabelClass(void) {
    return objc_getClass("YYLabel");
}

static NSAttributedString *_Nullable VTHGetAttributedText(id view) {
    SEL selector = @selector(attributedText);
    if (![view respondsToSelector:selector]) return nil;
    return ((NSAttributedString *(*)(id, SEL))objc_msgSend)(view, selector);
}

static NSString *_Nullable VTHGetText(id view) {
    SEL selector = @selector(text);
    if (![view respondsToSelector:selector]) return nil;
    return ((NSString *(*)(id, SEL))objc_msgSend)(view, selector);
}

static void VTHSetAttributedText(id view, NSAttributedString *text) {
    SEL selector = @selector(setAttributedText:);
    if ([view respondsToSelector:selector])
        ((void (*)(id, SEL, id))objc_msgSend)(view, selector, text);
}

static void VTHSetText(id view, NSString *text) {
    SEL selector = @selector(setText:);
    if ([view respondsToSelector:selector])
        ((void (*)(id, SEL, id))objc_msgSend)(view, selector, text);
}

#pragma mark - Text view hooks

static IMP VTHUILabelSetAttributedOriginal;
static IMP VTHUILabelSetTextOriginal;
static IMP VTHDCDLabelSetAttributedOriginal;
static IMP VTHDCDLabelSetTextOriginal;
static IMP VTHYYLabelSetAttributedOriginal;
static IMP VTHYYLabelSetTextOriginal;
static IMP VTHUITextViewSetAttributedOriginal;
static IMP VTHStandardEmojiLayoutOriginal;
static IMP VTHImageManagerGetEmojiOriginal;
static IMP VTHTextStorageAddLayoutOriginal;

static const void *VTHOriginalAttributedKey = &VTHOriginalAttributedKey;
static const void *VTHLastAttributedKey = &VTHLastAttributedKey;
static const void *VTHOriginalTextKey = &VTHOriginalTextKey;
static const void *VTHGenerationKey = &VTHGenerationKey;

typedef void (*VTHSetObjectIMP)(id, SEL, id _Nullable);


static void VTHHandleSetAttributedText(id self, NSAttributedString *_Nullable text, IMP original,
                                       BOOL requireAll) {
    if (!original) return;
    SEL selector = @selector(setAttributedText:);

    if (![[VTHEmojiApplier sharedApplier] hasSelection]) {
        objc_setAssociatedObject(self, VTHOriginalAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHOriginalTextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        ((VTHSetObjectIMP)original)(self, selector, text);
        return;
    }

    if (!text) {
        objc_setAssociatedObject(self, VTHOriginalAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHOriginalTextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        ((VTHSetObjectIMP)original)(self, selector, nil);
        return;
    }

    NSAttributedString *last = objc_getAssociatedObject(self, VTHLastAttributedKey);
    if (last && [text isEqualToAttributedString:last]) {
        ((void (*)(id, SEL, id))original)(self, selector, text);
        return;
    }

    objc_setAssociatedObject(self, VTHOriginalAttributedKey, text, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(self, VTHOriginalTextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    NSAttributedString *result = VTHEmojiTransform(text, VTHFontForView(self), requireAll);
    if (result != text) {
        objc_setAssociatedObject(self, VTHLastAttributedKey, result, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    } else {
       objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    ((void (*)(id, SEL, id))original)(self, selector, result);
}

static void VTHHandleSetText(id self, NSString *_Nullable text, IMP originalSetText,
                             IMP originalSetAttributedText, BOOL requireAll) {
    if (![[VTHEmojiApplier sharedApplier] hasSelection]) {
        objc_setAssociatedObject(self, VTHOriginalAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHOriginalTextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (originalSetText) ((VTHSetObjectIMP)originalSetText)(self, @selector(setText:), text);
        return;
    }

    if (!text) {
        objc_setAssociatedObject(self, VTHOriginalAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(self, VTHOriginalTextKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (originalSetText) ((VTHSetObjectIMP)originalSetText)(self, @selector(setText:), nil);
        return;
    }

    objc_setAssociatedObject(self, VTHOriginalTextKey, text, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(self, VTHOriginalAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(self, VTHLastAttributedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    UIFont *font = VTHFontForView(self);
    NSAttributedString *plain = VTHPlainAttributedString(text, font, VTHColorForView(self));
    NSAttributedString *result = VTHEmojiTransform(plain, font, requireAll);

    if (result == plain || !originalSetAttributedText) {
        if (originalSetText) ((void (*)(id, SEL, id))originalSetText)(self, @selector(setText:), text);
        return;
    }

    objc_setAssociatedObject(self, VTHLastAttributedKey, result, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ((void (*)(id, SEL, id))originalSetAttributedText)(self, @selector(setAttributedText:), result);
}

static void VTHInstallSetterHooks(void) {
    Class labelClass = [UILabel class];
    Method method = class_getInstanceMethod(labelClass, @selector(setAttributedText:));
    if (method && !VTHUILabelSetAttributedOriginal) {
        VTHUILabelSetAttributedOriginal = method_getImplementation(method);
        method_setImplementation(method, imp_implementationWithBlock(^(id self, NSAttributedString *text) {
            VTHHandleSetAttributedText(self, text, VTHUILabelSetAttributedOriginal, YES);
        }));
    }

    method = class_getInstanceMethod(labelClass, @selector(setText:));
    if (method && !VTHUILabelSetTextOriginal) {
        VTHUILabelSetTextOriginal = method_getImplementation(method);
        method_setImplementation(method, imp_implementationWithBlock(^(id self, NSString *text) {
            VTHHandleSetText(self, text, VTHUILabelSetTextOriginal,
                             VTHUILabelSetAttributedOriginal, YES);
        }));
    }

    Class dcdLabelClass = NSClassFromString(@"DCDLabel");
    if (dcdLabelClass && dcdLabelClass != labelClass) {
        method = class_getInstanceMethod(dcdLabelClass, @selector(setAttributedText:));
        if (method && !VTHDCDLabelSetAttributedOriginal) {
            VTHDCDLabelSetAttributedOriginal = method_getImplementation(method);
            method_setImplementation(method, imp_implementationWithBlock(^(id self, NSAttributedString *text) {
                VTHHandleSetAttributedText(self, text, VTHDCDLabelSetAttributedOriginal, NO);
            }));
        }

        method = class_getInstanceMethod(dcdLabelClass, @selector(setText:));
        if (method && !VTHDCDLabelSetTextOriginal) {
            VTHDCDLabelSetTextOriginal = method_getImplementation(method);
            method_setImplementation(method, imp_implementationWithBlock(^(id self, NSString *text) {
                VTHHandleSetText(self, text, VTHDCDLabelSetTextOriginal,
                                 VTHDCDLabelSetAttributedOriginal, NO);
            }));
        }
    }

    Class yyLabelClass = VTHYYLabelClass();
    if (yyLabelClass) {
        method = class_getInstanceMethod(yyLabelClass, @selector(setAttributedText:));
        if (method && !VTHYYLabelSetAttributedOriginal) {
            VTHYYLabelSetAttributedOriginal = method_getImplementation(method);
            method_setImplementation(method, imp_implementationWithBlock(^(id self, NSAttributedString *text) {
                VTHHandleSetAttributedText(self, text, VTHYYLabelSetAttributedOriginal, NO);
            }));
        }

        method = class_getInstanceMethod(yyLabelClass, @selector(setText:));
        if (method && !VTHYYLabelSetTextOriginal) {
            VTHYYLabelSetTextOriginal = method_getImplementation(method);
            method_setImplementation(method, imp_implementationWithBlock(^(id self, NSString *text) {
                VTHHandleSetText(self, text, VTHYYLabelSetTextOriginal,
                                 VTHYYLabelSetAttributedOriginal, NO);
            }));
        }
    }

    method = class_getInstanceMethod([UITextView class], @selector(setAttributedText:));
    if (method && !VTHUITextViewSetAttributedOriginal) {
        VTHUITextViewSetAttributedOriginal = method_getImplementation(method);
        method_setImplementation(method, imp_implementationWithBlock(^(id self, NSAttributedString *text) {
            VTHHandleSetAttributedText(self, text, VTHUITextViewSetAttributedOriginal, NO);
        }));
    }

    Class emojiViewClass = NSClassFromString(@"_TtC16DiscordBaseSwift27StandardEmojiAttachmentView");
    if (!emojiViewClass) emojiViewClass = NSClassFromString(@"DiscordBaseSwift.StandardEmojiAttachmentView");
    if (emojiViewClass && !VTHStandardEmojiLayoutOriginal) {
        method = class_getInstanceMethod(emojiViewClass, @selector(layoutSubviews));
        if (method) {
            VTHStandardEmojiLayoutOriginal = method_getImplementation(method);
            method_setImplementation(method, imp_implementationWithBlock(^(id self) {
                ((void (*)(id, SEL))VTHStandardEmojiLayoutOriginal)(self, @selector(layoutSubviews));
                if (!VTHUILabelSetAttributedOriginal) return;

                id label = VTHIvar(self, "label");
                id model = VTHIvar(self, "model");
                NSAttributedString *source = VTHIvar(model, "emojiString");
                if (![label isKindOfClass:[UILabel class]] || source.length == 0) return;

                VTHEmojiApplier *applier = [VTHEmojiApplier sharedApplier];
                NSAttributedString *current = ((UILabel *)label).attributedText;
                NSAttributedString *last = objc_getAssociatedObject(label, VTHLastAttributedKey);
                NSNumber *appliedGeneration = objc_getAssociatedObject(label, VTHGenerationKey);
                BOOL currentMatches = last ? [current isEqualToAttributedString:last]
                                           : [current isEqualToAttributedString:source];
                if (appliedGeneration.unsignedIntegerValue == applier.generation && currentMatches) return;

                objc_setAssociatedObject(label, VTHLastAttributedKey, nil,
                                         OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                VTHHandleSetAttributedText(label, source, VTHUILabelSetAttributedOriginal, NO);
                objc_setAssociatedObject(label, VTHGenerationKey, @(applier.generation),
                                         OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            }));
        }
    }
}

typedef void (*VTHGetEmojiBase64IMP)(id, SEL, NSString *, NSNumber *, id, id);

static void VTHInstallTextStorageHook(void) {
    if (VTHTextStorageAddLayoutOriginal) return;

    SEL selector = @selector(addLayoutManager:);
    Method method = class_getInstanceMethod([NSTextStorage class], selector);
    if (!method) return;

    VTHTextStorageAddLayoutOriginal = method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(
        ^(NSTextStorage *self, NSLayoutManager *layoutManager) {
            if (self.length && [[VTHEmojiApplier sharedApplier] hasSelection]) {
                NSAttributedString *transformed = VTHEmojiTransformOptions(self, nil, YES, YES);
                if (transformed != self) [self setAttributedString:transformed];
            }
            ((void (*)(id, SEL, NSLayoutManager *))VTHTextStorageAddLayoutOriginal)(
                self, selector, layoutManager);
        }));
}

static void VTHInstallImageManagerHook(void) {
    if (VTHImageManagerGetEmojiOriginal) return;

    Class managerClass = NSClassFromString(@"DCDImageManager");
    if (!managerClass) return;

    SEL selector = NSSelectorFromString(@"getEmojiBase64:size:resolve:reject:");
    Method method = class_getInstanceMethod(managerClass, selector);
    if (!method) return;

    VTHImageManagerGetEmojiOriginal = method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(
        ^(id self, NSString *emoji, NSNumber *size, id resolve, id reject) {
            VTHEmojiApplier *applier = [VTHEmojiApplier sharedApplier];
            if ([applier hasSelection] && [emoji isKindOfClass:[NSString class]]) {
                CGFloat pointSize = [size respondsToSelector:@selector(floatValue)]
                                  ? (CGFloat)[size floatValue] * 2.0 : 0;
                NSData *png = [applier pngDataForEmojiText:emoji size:pointSize];
                if (png) {
                    void (^resolveBlock)(id) = (void (^)(id))resolve;
                    if (resolveBlock) {
                        resolveBlock([png base64EncodedStringWithOptions:0]);
                        return;
                    }
                }
            }

            if (VTHImageManagerGetEmojiOriginal) {
                ((VTHGetEmojiBase64IMP)VTHImageManagerGetEmojiOriginal)(
                    self, selector, emoji, size, resolve, reject);
            }
        }));
}

static void VTHReapplyEmojiInView(UIView *view) {
    if ([view isKindOfClass:[UILabel class]]) {
        id label = view;
        NSAttributedString *originalAttributed = objc_getAssociatedObject(view, VTHOriginalAttributedKey);
        NSString *originalText = objc_getAssociatedObject(view, VTHOriginalTextKey);

        if (originalAttributed) {
            VTHSetAttributedText(label, originalAttributed);
        } else if (originalText) {
            VTHSetText(label, originalText);
        } else {
            NSAttributedString *current = VTHGetAttributedText(label);
            if (current.length && VTHStringMayContainNonASCII(current.string)) {
                VTHSetAttributedText(label, current);
            } else {
                NSString *text = VTHGetText(label);
                if (text.length && VTHStringMayContainNonASCII(text)) VTHSetText(label, text);
            }
        }
    } else if (VTHYYLabelClass() && [view isKindOfClass:VTHYYLabelClass()]) {
        id label = view;
        NSAttributedString *originalAttributed = objc_getAssociatedObject(view, VTHOriginalAttributedKey);
        NSString *originalText = objc_getAssociatedObject(view, VTHOriginalTextKey);

        if (originalAttributed) {
            VTHSetAttributedText(label, originalAttributed);
        } else if (originalText) {
            VTHSetText(label, originalText);
        } else {
            NSAttributedString *current = VTHGetAttributedText(label);
            if (current.length && VTHStringMayContainNonASCII(current.string)) {
                VTHSetAttributedText(label, current);
            } else {
                NSString *text = VTHGetText(label);
                if (text.length && VTHStringMayContainNonASCII(text)) VTHSetText(label, text);
            }
        }
    } else if ([view isKindOfClass:[UITextView class]]) {
        id textView = view;
        NSAttributedString *originalAttributed = objc_getAssociatedObject(view, VTHOriginalAttributedKey);
        if (originalAttributed) {
            VTHSetAttributedText(textView, originalAttributed);
        } else {
            NSAttributedString *current = VTHGetAttributedText(textView);
            if (current.length && VTHStringMayContainNonASCII(current.string))
                VTHSetAttributedText(textView, current);
        }
    }

    for (UIView *subview in view.subviews) VTHReapplyEmojiInView(subview);
}

static void VTHReapplyEmojiViews(void) {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ VTHReapplyEmojiViews(); });
        return;
    }

    UIApplication *application = [UIApplication sharedApplication];
    if (!application) return;

    for (UIScene *scene in application.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) VTHReapplyEmojiInView(window);
    }
}

static void VTHEmojiInstallHooks(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        Method imageNamed = class_getClassMethod([UIImage class], @selector(imageNamed:));
        if (imageNamed) {
            IMP original = method_getImplementation(imageNamed);
            IMP replacement = imp_implementationWithBlock(^UIImage *(id self, NSString *name) {
                NSString *path = [[VTHEmojiApplier sharedApplier] overridePathForAsset:name];
                UIImage *image = path ? [UIImage imageWithContentsOfFile:path] : nil;
                if (image) return image;
                return ((UIImage * (*)(id, SEL, NSString *))original)(self, @selector(imageNamed:), name);
            });
            method_setImplementation(imageNamed, replacement);
        }

        Method pathForResource = class_getInstanceMethod([NSBundle class], @selector(pathForResource:ofType:));
        if (pathForResource) {
            IMP original = method_getImplementation(pathForResource);
            IMP replacement = imp_implementationWithBlock(^NSString *(NSBundle *self, NSString *name, NSString *type) {
                NSString *asset = type.length ? [name stringByAppendingPathExtension:type] : name;
                NSString *path = [[VTHEmojiApplier sharedApplier] overridePathForAsset:asset];
                if (path) return path;
                return ((NSString * (*)(id, SEL, NSString *, NSString *))original)(self, @selector(pathForResource:ofType:), name, type);
            });
            method_setImplementation(pathForResource, replacement);
        }

        VTHInstallSetterHooks();
        VTHInstallImageManagerHook();
        VTHInstallTextStorageHook();
    });
}

@implementation VTHEmojiApplier {
    VTHEmojiSelection *_selection;
    NSMutableDictionary<NSString *, NSString *> *_cache;
    NSMutableDictionary<NSString *, NSString *> *_textCache;
    NSMutableDictionary<NSString *, UIImage *> *_imageCache;
    NSMutableSet<NSString *> *_logged;
    NSUInteger _generation;
}

+ (instancetype)sharedApplier {
    static VTHEmojiApplier *applier;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        applier = [[VTHEmojiApplier alloc] init];
        VTHEmojiInstallHooks();
    });
    return applier;
}

- (instancetype)init {
    if ((self = [super init])) {
        _cache = [NSMutableDictionary dictionary];
        _textCache = [NSMutableDictionary dictionary];
        _imageCache = [NSMutableDictionary dictionary];
        _logged = [NSMutableSet set];
    }
    return self;
}

- (void)apply:(nullable VTHEmojiSelection *)selection {
    @synchronized(self) {
        _selection = selection;
        _generation++;
        [_cache removeAllObjects];
        [_textCache removeAllObjects];
        [_imageCache removeAllObjects];
        [_logged removeAllObjects];
    }

    if (self == [VTHEmojiApplier sharedApplier]) {
        if (selection) {
            ValencedLog(@"Themes: applied emoji pack images=%@ font=%@",
                        selection.images ?: @"(none)", selection.font ?: @"(none)");
        } else {
            ValencedLog(@"Themes: cleared emoji pack");
        }

        VTHInstallSetterHooks();
        VTHInstallImageManagerHook();
        VTHInstallTextStorageHook();
        VTHReapplyEmojiViews();
    }
}

- (BOOL)hasSelection {
    @synchronized(self) { return _selection != nil; }
}

- (NSUInteger)generation {
    @synchronized(self) { return _generation; }
}

- (NSString *)cacheDirectory {
    VTHEmojiSelection *selection = _selection;
    NSMutableString *key = [NSMutableString stringWithFormat:@"%@|%@|%@|%@",
        selection.plugin, selection.group, selection.pack, selection.font ?: @""];
    if (selection.font.length && ![selection.font isEqualToString:VTHSystemEmojiFont]) {
        NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:selection.font error:nil];
        [key appendFormat:@"|%@", attributes[NSFileModificationDate]];
    }
    NSURL *dir = [[getValencedDirectory() URLByAppendingPathComponent:PLUGIN_STORAGE_DIR]
        URLByAppendingPathComponent:[NSString stringWithFormat:@"valenced.api.themes/emoji-cache/%lx", (unsigned long)key.hash]];
    return dir.path;
}

- (nullable UIFont *)emojiFont {
    NSString *font = _selection.font;
    if (!font) return nil;
    if ([font isEqualToString:VTHSystemEmojiFont]) {
        return [UIFont fontWithName:@"AppleColorEmoji" size:128.0];
    }
    NSString *postScript = VTHEmojiRegisterFont(font);
    if (!postScript) {
        ValencedLog(@"Themes: missing emoji font %@", font);
        return nil;
    }
    return [UIFont fontWithName:postScript size:128.0];
}

- (nullable NSString *)drawnEmojiForCodepoints:(NSString *)codepoints {
    if (!_selection.font) return nil;

    NSString *cacheDir = [self cacheDirectory];
    NSString *file = [cacheDir stringByAppendingPathComponent:
        [NSString stringWithFormat:@"emoji-%@.png", codepoints]];
    if ([[NSFileManager defaultManager] fileExistsAtPath:file]) return file;

    UIFont *font = [self emojiFont];
    NSString *text = VTHEmojiText(codepoints);
    if (!font || text.length == 0) return nil;

    CGSize canvas = CGSizeMake(kEmojiCanvasSize, kEmojiCanvasSize);
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
    format.opaque = NO;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:canvas format:format];
    UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        NSDictionary *attributes = @{ NSFontAttributeName: font };
        CGSize textSize = [text sizeWithAttributes:attributes];
        if (textSize.width <= 0 || textSize.height <= 0) return;
        CGFloat scale = MIN(1.0, canvas.width / textSize.width);
        scale = MIN(scale, canvas.height / textSize.height);

        CGContextRef cg = context.CGContext;
        CGContextTranslateCTM(cg, canvas.width / 2.0, canvas.height / 2.0);
        CGContextScaleCTM(cg, scale, scale);
        [text drawAtPoint:CGPointMake(-textSize.width / 2.0, -textSize.height / 2.0)
           withAttributes:attributes];
    }];
    NSData *png = UIImagePNGRepresentation(image);
    if (!png) return nil;

    [[NSFileManager defaultManager] createDirectoryAtPath:cacheDir
                              withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *temp = [cacheDir stringByAppendingPathComponent:
        [NSString stringWithFormat:@".emoji-%@.tmp", NSUUID.UUID.UUIDString]];
    if (![png writeToFile:temp atomically:YES]) return nil;
    if (![[NSFileManager defaultManager] moveItemAtPath:temp toPath:file error:nil]) {
        [[NSFileManager defaultManager] removeItemAtPath:temp error:nil];
        return nil;
    }
    return file;
}

- (nullable NSString *)overridePathForAsset:(NSString *)assetName {
    if (assetName.length == 0) return nil;
    @synchronized(self) {
        VTHEmojiSelection *selection = _selection;
        if (!selection) return nil;

        NSString *cached = _cache[assetName];
        if (cached) return cached.length == 0 ? nil : cached;

        NSString *resolved = nil;

        NSString *candidate = VTHEmojiNormalizeAssetName(assetName);
        if (![candidate hasSuffix:@".png"]) candidate = [candidate stringByAppendingPathExtension:@"png"];
        NSString *codepoints = VTHEmojiCodepoints(candidate);
        if (!codepoints) {
            _cache[assetName] = @"";
            return nil;
        }

        if (selection.images) {
            for (NSString *name in VTHEmojiImageNames(codepoints)) {
                NSString *path = [selection.images stringByAppendingPathComponent:name];
                if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
                    resolved = path;
                    break;
                }
            }
        }
        if (!resolved) resolved = [self drawnEmojiForCodepoints:codepoints];

        _cache[assetName] = resolved ?: @"";
        return resolved;
    }
}

- (nullable NSString *)overridePathForEmojiText:(NSString *)text {
    NSString *codepoints = VTHEmojiCodepointsForText(text);
    if (!codepoints) return nil;

    @synchronized(self) {
        NSString *cached = _textCache[codepoints];
        if (cached) return cached.length == 0 ? nil : cached;

        VTHEmojiSelection *selection = _selection;
        if (!selection) {
            _textCache[codepoints] = @"";
            return nil;
        }

        NSString *resolved = nil;
        if (selection.images) {
            for (NSString *name in VTHEmojiImageNames(codepoints)) {
                NSString *path = [selection.images stringByAppendingPathComponent:name];
                if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
                    resolved = path;
                    break;
                }
            }
        }
        if (!resolved) resolved = [self drawnEmojiForCodepoints:codepoints];

        if (resolved && _logged.count < 20 && ![_logged containsObject:codepoints]) {
            [_logged addObject:codepoints];
            ValencedLog(@"Themes: emoji %@ -> %@", codepoints, resolved.lastPathComponent);
        }

        _textCache[codepoints] = resolved ?: @"";
        return resolved;
    }
}

- (nullable UIImage *)imageForEmojiText:(NSString *)text {
    NSString *path = [self overridePathForEmojiText:text];
    if (!path) return nil;

    @synchronized(self) {
        UIImage *image = _imageCache[path];
        if (!image) {
            image = [UIImage imageWithContentsOfFile:path];
            if (image) _imageCache[path] = image;
        }
        return image;
    }
}

- (nullable NSData *)pngDataForEmojiText:(NSString *)text size:(CGFloat)size {
    UIImage *image = [self imageForEmojiText:text];
    if (!image) return nil;
    if (size <= 0) return UIImagePNGRepresentation(image);

    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
    format.opaque = NO;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc]
        initWithSize:CGSizeMake(size, size) format:format];
    UIImage *rendered = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        CGSize imageSize = image.size;
        if (imageSize.width <= 0 || imageSize.height <= 0) return;
        CGFloat scale = MIN(size / imageSize.width, size / imageSize.height);
        CGSize drawSize = CGSizeMake(imageSize.width * scale, imageSize.height * scale);
        [image drawInRect:CGRectMake((size - drawSize.width) / 2.0,
                                     (size - drawSize.height) / 2.0,
                                     drawSize.width, drawSize.height)];
    }];
    return UIImagePNGRepresentation(rendered);
}

@end

NS_ASSUME_NONNULL_END
