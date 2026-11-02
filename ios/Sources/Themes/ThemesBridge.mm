#import "Themes.h"
#import "Bridge.h"
#import "Logger.h"

NS_ASSUME_NONNULL_BEGIN

static NSDictionary *_Nullable bridgeDict(NSDictionary *json, NSString *key) {
    id value = json[key];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

void RegisterThemesBridgeMethods(void) {
    bridgeHandlers()[@"valenced.themes.getState"] = ^NSDictionary *(NSArray *args) {
        VTHThemesState *state = [[VTHStateStore sharedStore] load];
        NSDictionary   *json  = [state toJson];

        NSError *error = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:json options:0 error:&error];
        NSString *str = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
        if (error) {
            ValencedLog(@"Themes: getState JSON error %@", error.localizedDescription);
            str = @"{\"format\":1}";
        }
        return @{ @"result": str };
    };

    bridgeHandlers()[@"valenced.themes.setColors"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (jsonArg == [NSNull null] || !jsonArg) {
            [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
                return [[VTHThemesState alloc] initWithFormat:s.format colors:nil fonts:s.fonts icons:s.icons emoji:s.emoji];
            }];
            [[VTHColorApplier sharedApplier] apply:nil];
            return @{ @"result": [NSNull null] };
        }

        if (![jsonArg isKindOfClass:[NSString class]]) {
            ValencedLog(@"Themes: setColors expects string or null");
            return @{ @"error": @"Invalid argument" };
        }

        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: setColors parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        VTHColorsSelection *selection = VTHColorsSelectionOf(parsed);
        [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
            return [[VTHThemesState alloc] initWithFormat:s.format colors:selection fonts:s.fonts icons:s.icons emoji:s.emoji];
        }];
        [[VTHColorApplier sharedApplier] apply:selection];
        return @{ @"result": [NSNull null] };
    };

    bridgeHandlers()[@"valenced.themes.setFonts"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (jsonArg == [NSNull null] || !jsonArg) {
            [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
                return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:nil icons:s.icons emoji:s.emoji];
            }];
            [[VTHFontApplier sharedApplier] apply:nil];
            return @{ @"result": [NSNull null] };
        }

        if (![jsonArg isKindOfClass:[NSString class]]) {
            return @{ @"error": @"Invalid argument" };
        }

        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: setFonts parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        VTHFontsSelection *selection = VTHFontsSelectionOf(parsed);
        [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
            return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:selection icons:s.icons emoji:s.emoji];
        }];
        [[VTHFontApplier sharedApplier] apply:selection];
        return @{ @"result": [NSNull null] };
    };

    bridgeHandlers()[@"valenced.themes.setIcons"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (jsonArg == [NSNull null] || !jsonArg) {
            [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
                return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:s.fonts icons:nil emoji:s.emoji];
            }];
            return @{ @"result": [NSNull null] };
        }

        if (![jsonArg isKindOfClass:[NSString class]]) {
            return @{ @"error": @"Invalid argument" };
        }

        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: setIcons parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        VTHIconsSelection *selection = VTHIconsSelectionOf(parsed);
        [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
            return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:s.fonts icons:selection emoji:s.emoji];
        }];
        return @{ @"result": [NSNull null] };
    };

    bridgeHandlers()[@"valenced.themes.setEmoji"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (jsonArg == [NSNull null] || !jsonArg) {
            [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
                return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:s.fonts icons:s.icons emoji:nil];
            }];
            [[VTHEmojiApplier sharedApplier] apply:nil];
            return @{ @"result": [NSNull null] };
        }

        if (![jsonArg isKindOfClass:[NSString class]]) {
            return @{ @"error": @"Invalid argument" };
        }

        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: setEmoji parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        VTHEmojiSelection *selection = VTHEmojiSelectionOf(parsed);
        [[VTHStateStore sharedStore] update:^VTHThemesState *(VTHThemesState *s) {
            return [[VTHThemesState alloc] initWithFormat:s.format colors:s.colors fonts:s.fonts icons:s.icons emoji:selection];
        }];
        [[VTHEmojiApplier sharedApplier] apply:selection];
        return @{ @"result": [NSNull null] };
    };

    bridgeHandlers()[@"valenced.themes.previewFont"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (![jsonArg isKindOfClass:[NSString class]]) {
            return @{ @"error": @"Invalid argument" };
        }
        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: previewFont parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        NSString *name = VTHOptString(parsed, @"name") ?: @"";
        NSArray *variantsJson = nil;
        id variantsValue = parsed[@"variants"];
        if ([variantsValue isKindOfClass:[NSArray class]]) variantsJson = variantsValue;

        NSMutableArray<VTHFontVariant *> *variants = [NSMutableArray array];
        for (id variant in variantsJson)
            if ([variant isKindOfClass:[NSDictionary class]])
                [variants addObject:VTHFontVariantOf(variant)];

        [[VTHFontApplier sharedApplier] registerPreviewFamily:name variants:variants];
        return @{ @"result": [NSNull null] };
    };

    bridgeHandlers()[@"valenced.themes.previewEmoji"] = ^NSDictionary *(NSArray *args) {
        id jsonArg = args.count > 0 ? args[0] : [NSNull null];
        if (![jsonArg isKindOfClass:[NSString class]]) {
            return @{ @"error": @"Invalid argument" };
        }
        NSString *str = jsonArg;
        NSData *data = [str dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: previewEmoji parse error %@", error.localizedDescription ?: @"unparseable");
            return @{ @"error": @"Invalid JSON" };
        }

        NSDictionary *pack = bridgeDict(parsed, @"pack");
        NSArray *codepoints = nil;
        id cps = parsed[@"codepoints"];
        if ([cps isKindOfClass:[NSArray class]]) codepoints = cps;

        VTHEmojiSelection *override = nil;
        if (pack) {
            NSString *images = VTHOptString(pack, @"images");
            NSString *font = VTHOptString(pack, @"font");
            override = [[VTHEmojiSelection alloc] initWithPlugin:@"" group:@"" pack:@"" images:images font:font];
        }

        VTHEmojiApplier *applier = [[VTHEmojiApplier alloc] init];
        [applier apply:override];
        NSMutableArray *result = [NSMutableArray array];
        for (id cp in codepoints) {
            NSString *name = [NSString stringWithFormat:@"emoji-%@.png", [cp description]];
            NSString *path = [applier overridePathForAsset:name];
            [result addObject:path ? path : [NSNull null]];
        }

        NSData *resData = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *resStr = resData ? [[NSString alloc] initWithData:resData encoding:NSUTF8StringEncoding] : @"[]";
        return @{ @"result": resStr };
    };
}

void ThemesApplyAtBoot(void) {
    VTHThemesState *state = [[VTHStateStore sharedStore] load];
    if (state.colors) [[VTHColorApplier sharedApplier] apply:state.colors];
    if (state.fonts) [[VTHFontApplier sharedApplier] apply:state.fonts];
    if (state.emoji) [[VTHEmojiApplier sharedApplier] apply:state.emoji];
}

NS_ASSUME_NONNULL_END
