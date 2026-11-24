cmake_minimum_required(VERSION 3.22)

project(valenced_phoenix LANGUAGES C)

set(QUICKJS_DIR "" CACHE PATH "Extracted quickjs-ng source tree")
if(NOT QUICKJS_DIR OR NOT EXISTS "${QUICKJS_DIR}/quickjs.c")
    message(FATAL_ERROR
        "QUICKJS_DIR does not point at a quickjs-ng source tree (got '${QUICKJS_DIR}'). "
        "Run :android:fetchQuickjs.")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_LIBC OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_WERROR OFF CACHE BOOL "" FORCE)

# EXCLUDE_FROM_ALL keeps the qjs and qjsc executables out of the build. They would
# cross-compile for Android and never run.
add_subdirectory("${QUICKJS_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/quickjs" EXCLUDE_FROM_ALL)

add_library(valenced_phoenix SHARED
    src/runtime.c
    src/bridge.c
    src/frames.c
    src/image.c
    src/access.c
    src/gateway.c
    src/jni.c
)

target_compile_options(valenced_phoenix PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
    -ffunction-sections
    -fdata-sections
)

target_link_options(valenced_phoenix PRIVATE -Wl,--gc-sections)

target_link_libraries(valenced_phoenix PRIVATE qjs log)
