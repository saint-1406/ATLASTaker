# The scanner's recognizer (libatlasocr.so): ncnn runs the PaddleOCR models, OpenCV (opencv-mobile,
# core and imgproc only) cuts the lines out. Both come as prebuilt static libraries that
# scripts/android-ocr-deps.mjs downloads and checks into third_party/ (not kept in git).

cmake_minimum_required(VERSION 3.22.1)
project(atlasocr CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(DEPS ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
if(NOT EXISTS ${DEPS}/ncnn/${ANDROID_ABI}/lib/cmake/ncnn OR NOT EXISTS ${DEPS}/opencv-mobile/sdk/native/jni)
    message(FATAL_ERROR "The OCR libraries are missing: run `node scripts/android-ocr-deps.mjs` first")
endif()

set(ncnn_DIR ${DEPS}/ncnn/${ANDROID_ABI}/lib/cmake/ncnn)
find_package(ncnn REQUIRED)

set(OpenCV_DIR ${DEPS}/opencv-mobile/sdk/native/jni)
find_package(OpenCV REQUIRED core imgproc)

add_library(atlasocr SHARED atlas_ocr.cpp atlas_ocr_jni.cpp)
target_link_libraries(atlasocr ncnn ${OpenCV_LIBS} log)

# ncnn asks for -fno-exceptions; this code catches running out of memory, so it keeps exceptions
target_compile_options(atlasocr PRIVATE -fexceptions -O2 -fvisibility=hidden -ffunction-sections -fdata-sections)
# only what is used goes into the library; 16 KB pages for Android 15+ devices
target_link_options(atlasocr PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL -Wl,-z,max-page-size=16384)
