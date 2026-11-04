TARGET := iphone:clang:latest:14.0
SDK = iPhoneOS16.5
ARCHS = arm64
INSTALL_TARGET_PROCESSES = Discord
THEOS_PACKAGE_SCHEME = rootless
FINALPACKAGE = 1
VERSION_CODE = 1.0.0

THEOS ?= $(HOME)/theos
export THEOS

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = ValencedTweak

ValencedTweak_FILES = $(wildcard Sources/*.x Sources/*.xm Sources/*.m Sources/*.mm Sources/**/*.x Sources/**/*.xm Sources/**/*.m Sources/**/*.mm)
ValencedTweak_CFLAGS = -fobjc-arc -DPACKAGE_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"' -DVERSION_CODE='@"$(VERSION_CODE)"' -I$(THEOS_PROJECT_DIR)/Headers
ValencedTweak_CCFLAGS = -std=c++17 -Wno-c++11-narrowing -I$(THEOS_PROJECT_DIR)/Headers
ValencedTweak_FRAMEWORKS = Foundation UIKit CoreGraphics CoreText CoreFoundation UniformTypeIdentifiers
ValencedTweak_LDFLAGS = -undefined dynamic_lookup -lz

ifneq ($(VALENCED_CORE_LIB),)
ValencedTweak_LDFLAGS += -Wl,-force_load,$(VALENCED_CORE_LIB)
else
ValencedTweak_FRAMEWORKS += ValencedCore
ValencedTweak_CFLAGS += -F$(VALENCED_CORE_FW)
ValencedTweak_CCFLAGS += -F$(VALENCED_CORE_FW)
ValencedTweak_LDFLAGS += -F$(VALENCED_CORE_FW) -Wl,-force_load,$(VALENCED_CORE_FW)/ValencedCore
endif

include $(THEOS_MAKE_PATH)/tweak.mk

after-stage::
	$(ECHO_NOTHING)find $(THEOS_STAGING_DIR) -name ".DS_Store" -delete$(ECHO_END)
ifneq ($(VALENCED_BUNDLE_DIR),)
	$(ECHO_NOTHING)cp $(VALENCED_BUNDLE_DIR)/valenced.bundle $(THEOS_STAGING_DIR)/Library/MobileSubstrate/DynamicLibraries/$(ECHO_END)
	$(ECHO_NOTHING)cp $(VALENCED_BUNDLE_DIR)/manifest.json $(THEOS_STAGING_DIR)/Library/MobileSubstrate/DynamicLibraries/valenced.manifest.json$(ECHO_END)
endif
