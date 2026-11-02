#import "Themes.h"

#import "Constants.h"
#import "Logger.h"
#import "Utils.h"

NS_ASSUME_NONNULL_BEGIN

NSString *const VTHThemeBaseDark = @"dark";
NSString *const VTHThemeBaseDarker = @"darker";
NSString *const VTHThemeBaseLight = @"light";
NSString *const VTHThemeBaseMidnight = @"midnight";
NSString *const VTHSystemEmojiFont = @"system";

static NSString *const kThemesPluginId = @"valenced.api.themes";
static const int kThemesStateFormat = 1;

NSString *_Nullable VTHOptString(NSDictionary *_Nullable json, NSString *key) {
    id value = json[key];
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

NSString *VTHOptStringOrEmpty(NSDictionary *_Nullable json, NSString *key) {
    return VTHOptString(json, key) ?: @"";
}

static int VTHOptInt(NSDictionary *_Nullable json, NSString *key, int fallback) {
    id value = json[key];
    return [value isKindOfClass:[NSNumber class]] ? [(NSNumber *)value intValue] : fallback;
}

static BOOL VTHOptBool(NSDictionary *_Nullable json, NSString *key, BOOL fallback) {
    id value = json[key];
    return [value isKindOfClass:[NSNumber class]] ? [(NSNumber *)value boolValue] : fallback;
}

static NSDictionary *_Nullable VTHOptDict(NSDictionary *_Nullable json, NSString *key) {
    id value = json[key];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static NSDictionary<NSString *, NSString *> *VTHStringMap(NSDictionary *_Nullable json) {
    if (!json) return @{};
    NSMutableDictionary<NSString *, NSString *> *map = [NSMutableDictionary dictionary];
    for (id key in json) {
        if (![key isKindOfClass:[NSString class]]) continue;
        id value = json[key];
        map[key] = [value isKindOfClass:[NSString class]] ? value : [value description] ?: @"";
    }
    return map;
}

@implementation VTHRawColors
- (instancetype)initWithByName:(NSDictionary<NSString *, NSString *> *)byName {
    if ((self = [super init])) _byName = [byName copy];
    return self;
}
@end

@implementation VTHSemanticColors
- (instancetype)initWithByBase:(NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *)byBase {
    if ((self = [super init])) _byBase = [byBase copy];
    return self;
}

- (nullable NSString *)hexForBase:(NSString *)base name:(NSString *)name {
    return _byBase[base][name];
}
@end

@implementation VTHColorsSelection
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                         theme:(NSString *)theme
                      semantic:(VTHSemanticColors *)semantic
                           raw:(VTHRawColors *)raw {
    if ((self = [super init])) {
        _plugin = [plugin copy];
        _group = [group copy];
        _theme = [theme copy];
        _semantic = semantic;
        _raw = raw;
    }
    return self;
}

- (NSDictionary *)toJson {
    NSMutableDictionary *semantic = [NSMutableDictionary dictionary];
    for (NSString *base in _semantic.byBase)
        semantic[base] = [_semantic.byBase[base] copy];
    return @{
        @"plugin": _plugin,
        @"group": _group,
        @"theme": _theme,
        @"values": @{ @"semantic": semantic, @"raw": _raw.byName },
    };
}
@end

@implementation VTHFontVariant
- (instancetype)initWithPath:(NSString *)path
                      weight:(int)weight
                      italic:(BOOL)italic
                        axes:(NSDictionary<NSString *, NSNumber *> *)axes {
    if ((self = [super init])) {
        _path = [path copy];
        _weight = weight;
        _italic = italic;
        _axes = [axes copy];
    }
    return self;
}

- (NSDictionary *)toJson {
    NSMutableDictionary *json = [NSMutableDictionary dictionaryWithObject:_path forKey:@"path"];
    json[@"weight"] = @(_weight);
    json[@"italic"] = @(_italic);
    if (_axes.count) json[@"axes"] = _axes;
    return json;
}
@end

@implementation VTHFontSource
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                      variants:(NSArray<VTHFontVariant *> *)variants {
    if ((self = [super init])) {
        _plugin = [plugin copy];
        _group = [group copy];
        _pack = [pack copy];
        _variants = [variants copy];
    }
    return self;
}

- (NSDictionary *)toJson {
    NSMutableArray *variants = [NSMutableArray arrayWithCapacity:_variants.count];
    for (VTHFontVariant *variant in _variants) [variants addObject:[variant toJson]];
    return @{ @"plugin": _plugin, @"group": _group, @"pack": _pack, @"variants": variants };
}
@end

@implementation VTHFontsSelection
- (instancetype)initWithSources:(NSDictionary<NSString *, VTHFontSource *> *)sources {
    if ((self = [super init])) _sources = [sources copy];
    return self;
}

- (NSDictionary *)toJson {
    NSMutableDictionary *families = [NSMutableDictionary dictionary];
    for (NSString *family in _sources) families[family] = [_sources[family] toJson];
    return @{ @"families": families };
}
@end

@implementation VTHIconsSelection
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                          icons:(NSDictionary<NSString *, NSString *> *)icons
                      drawables:(NSDictionary<NSString *, NSString *> *)drawables {
    if ((self = [super init])) {
        _plugin = [plugin copy];
        _group = [group copy];
        _pack = [pack copy];
        _icons = [icons copy];
        _drawables = [drawables copy];
    }
    return self;
}

- (NSDictionary *)toJson {
    return @{
        @"plugin": _plugin,
        @"group": _group,
        @"pack": _pack,
        @"icons": _icons,
        @"drawables": _drawables,
    };
}
@end

@implementation VTHEmojiSelection
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                        images:(nullable NSString *)images
                          font:(nullable NSString *)font {
    if ((self = [super init])) {
        _plugin = [plugin copy];
        _group = [group copy];
        _pack = [pack copy];
        _images = [images copy];
        _font = [font copy];
    }
    return self;
}

- (NSDictionary *)toJson {
    NSMutableDictionary *json = [NSMutableDictionary dictionaryWithObjectsAndKeys:
        _plugin, @"plugin", _group, @"group", _pack, @"pack", nil];
    if (_images) json[@"images"] = _images;
    if (_font) json[@"font"] = _font;
    return json;
}
@end

@implementation VTHThemesState
- (instancetype)initWithFormat:(int)format
                        colors:(nullable VTHColorsSelection *)colors
                         fonts:(nullable VTHFontsSelection *)fonts
                         icons:(nullable VTHIconsSelection *)icons
                         emoji:(nullable VTHEmojiSelection *)emoji {
    if ((self = [super init])) {
        _format = format;
        _colors = colors;
        _fonts = fonts;
        _icons = icons;
        _emoji = emoji;
    }
    return self;
}

- (NSDictionary *)toJson {
    NSMutableDictionary *json = [NSMutableDictionary dictionaryWithObject:@(_format) forKey:@"format"];
    if (_colors) json[@"colors"] = [_colors toJson];
    if (_fonts) json[@"fonts"] = [_fonts toJson];
    if (_icons) json[@"icons"] = [_icons toJson];
    if (_emoji) json[@"emoji"] = [_emoji toJson];
    return json;
}
@end

VTHColorsSelection *VTHColorsSelectionOf(NSDictionary *json) {
    NSDictionary *values = VTHOptDict(json, @"values");

    NSDictionary *semanticJson = VTHOptDict(values, @"semantic");
    NSMutableDictionary *byBase = [NSMutableDictionary dictionary];
    for (NSString *base in semanticJson) {
        id map = semanticJson[base];
        if ([map isKindOfClass:[NSDictionary class]]) byBase[base] = VTHStringMap(map);
    }

    VTHSemanticColors *semantic = [[VTHSemanticColors alloc] initWithByBase:byBase];
    VTHRawColors *raw = [[VTHRawColors alloc] initWithByName:VTHStringMap(VTHOptDict(values, @"raw"))];

    return [[VTHColorsSelection alloc] initWithPlugin:VTHOptStringOrEmpty(json, @"plugin")
                                                group:VTHOptStringOrEmpty(json, @"group")
                                                theme:VTHOptStringOrEmpty(json, @"theme")
                                             semantic:semantic
                                                  raw:raw];
}

VTHFontVariant *VTHFontVariantOf(NSDictionary *json) {
    NSDictionary *axesJson = VTHOptDict(json, @"axes");
    NSMutableDictionary<NSString *, NSNumber *> *axes = [NSMutableDictionary dictionary];
    for (NSString *tag in axesJson) {
        id value = axesJson[tag];
        if ([value isKindOfClass:[NSNumber class]]) axes[tag] = value;
    }
    return [[VTHFontVariant alloc] initWithPath:VTHOptStringOrEmpty(json, @"path")
                                         weight:VTHOptInt(json, @"weight", 400)
                                         italic:VTHOptBool(json, @"italic", NO)
                                           axes:axes];
}

VTHFontsSelection *VTHFontsSelectionOf(NSDictionary *json) {
    NSDictionary *families = VTHOptDict(json, @"families");
    NSMutableDictionary<NSString *, VTHFontSource *> *sources = [NSMutableDictionary dictionary];
    for (NSString *family in families) {
        NSDictionary *source = families[family];
        if (![source isKindOfClass:[NSDictionary class]]) continue;

        NSArray *rawVariants = nil;
        id variantsValue = source[@"variants"];
        if ([variantsValue isKindOfClass:[NSArray class]]) rawVariants = variantsValue;

        NSMutableArray<VTHFontVariant *> *variants = [NSMutableArray array];
        for (id variant in rawVariants)
            if ([variant isKindOfClass:[NSDictionary class]])
                [variants addObject:VTHFontVariantOf(variant)];

        sources[family] = [[VTHFontSource alloc] initWithPlugin:VTHOptStringOrEmpty(source, @"plugin")
                                                          group:VTHOptStringOrEmpty(source, @"group")
                                                           pack:VTHOptStringOrEmpty(source, @"pack")
                                                       variants:variants];
    }
    return [[VTHFontsSelection alloc] initWithSources:sources];
}

VTHIconsSelection *VTHIconsSelectionOf(NSDictionary *json) {
    return [[VTHIconsSelection alloc] initWithPlugin:VTHOptStringOrEmpty(json, @"plugin")
                                               group:VTHOptStringOrEmpty(json, @"group")
                                                pack:VTHOptStringOrEmpty(json, @"pack")
                                                icons:VTHStringMap(VTHOptDict(json, @"icons"))
                                            drawables:VTHStringMap(VTHOptDict(json, @"drawables"))];
}

VTHEmojiSelection *VTHEmojiSelectionOf(NSDictionary *json) {
    return [[VTHEmojiSelection alloc] initWithPlugin:VTHOptStringOrEmpty(json, @"plugin")
                                               group:VTHOptStringOrEmpty(json, @"group")
                                               pack:VTHOptStringOrEmpty(json, @"pack")
                                             images:VTHOptString(json, @"images")
                                               font:VTHOptString(json, @"font")];
}

static VTHThemesState *VTHThemesStateOf(NSDictionary *json) {
    return [[VTHThemesState alloc] initWithFormat:VTHOptInt(json, @"format", kThemesStateFormat)
                                           colors:VTHOptDict(json, @"colors") ? VTHColorsSelectionOf(VTHOptDict(json, @"colors")) : nil
                                            fonts:VTHOptDict(json, @"fonts") ? VTHFontsSelectionOf(VTHOptDict(json, @"fonts")) : nil
                                            icons:VTHOptDict(json, @"icons") ? VTHIconsSelectionOf(VTHOptDict(json, @"icons")) : nil
                                            emoji:VTHOptDict(json, @"emoji") ? VTHEmojiSelectionOf(VTHOptDict(json, @"emoji")) : nil];
}

@implementation VTHStateStore {
    VTHThemesState *_state;
}

+ (instancetype)sharedStore {
    static VTHStateStore *store;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ store = [[VTHStateStore alloc] init]; });
    return store;
}

- (instancetype)init {
    if ((self = [super init])) {
        _state = [[VTHThemesState alloc] initWithFormat:kThemesStateFormat colors:nil fonts:nil icons:nil emoji:nil];
    }
    return self;
}

- (NSString *)stateFilePath {
    NSURL *dir = [[getValencedDirectory() URLByAppendingPathComponent:PLUGIN_STORAGE_DIR]
        URLByAppendingPathComponent:kThemesPluginId];
    return [dir URLByAppendingPathComponent:@"state.json"].path;
}

- (VTHThemesState *)state {
    return _state;
}

- (VTHThemesState *)load {
    @synchronized(self) {
        NSString *path = [self stateFilePath];
        NSData *data = [NSData dataWithContentsOfFile:path];
        if (!data) {
            _state = [[VTHThemesState alloc] initWithFormat:kThemesStateFormat colors:nil fonts:nil icons:nil emoji:nil];
            return _state;
        }

        NSError *error = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if (![parsed isKindOfClass:[NSDictionary class]]) {
            ValencedLog(@"Themes: failed to read state.json (%@)", error.localizedDescription ?: @"unparseable");
            _state = [[VTHThemesState alloc] initWithFormat:kThemesStateFormat colors:nil fonts:nil icons:nil emoji:nil];
            return _state;
        }

        VTHThemesState *state = VTHThemesStateOf(parsed);
        _state = (state.format == kThemesStateFormat) ? state
            : [[VTHThemesState alloc] initWithFormat:kThemesStateFormat colors:nil fonts:nil icons:nil emoji:nil];
        return _state;
    }
}

- (VTHThemesState *)update:(VTHThemesState * (^)(VTHThemesState *))transform {
    @synchronized(self) {
        VTHThemesState *next = transform(_state);
        NSData *json = [NSJSONSerialization dataWithJSONObject:[next toJson] options:0 error:nil];
        if (json) {
            NSString *path = [self stateFilePath];
            [[NSFileManager defaultManager] createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                                      withIntermediateDirectories:YES
                                                       attributes:nil
                                                            error:nil];
            [json writeToFile:path atomically:YES];
        } else {
            ValencedLog(@"Themes: failed to encode state.json");
        }
        _state = next;
        return next;
    }
}

@end

NS_ASSUME_NONNULL_END
