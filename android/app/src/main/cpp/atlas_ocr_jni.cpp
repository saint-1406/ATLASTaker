// The scanner's recognizer for Java (OcrEngine.java): load the models, read a page, let go of them.
// One page at a time: OcrEngine calls in from its own single thread.

#include <jni.h>

#include <atomic>
#include <cstdio>
#include <mutex>
#include <new>
#include <string>

#include <opencv2/core/core.hpp>
#include <opencv2/imgproc/imgproc.hpp>

#include "atlas_ocr.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "AtlasOcr", __VA_ARGS__)
#else
#define LOGE(...) std::fprintf(stderr, __VA_ARGS__)
#endif

namespace {

atlas::Ocr* engine = nullptr;
std::mutex lock;
std::atomic<bool> cancelled(false);

/** A JSON string literal of UTF-8 text. */
void quote(std::string& out, const std::string& text)
{
    out += '"';
    for (unsigned char c : text)
    {
        switch (c)
        {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20)
            {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            }
            else
            {
                out += (char)c;
            }
        }
    }
    out += '"';
}

std::string num(double v, int decimals)
{
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.*f", decimals, v);
    return buf;
}

std::string failure(const char* code)
{
    return std::string("{\"ok\":false,\"code\":\"") + code + "\"}";
}

/**
 * Modified UTF-8 is what NewStringUTF wants; the answer is plain JSON with every character outside
 * ASCII written as \uXXXX (surrogate pairs above U+FFFF), so any Java string conversion keeps it.
 */
std::string asciiJson(const std::string& utf8)
{
    std::string out;
    out.reserve(utf8.size());
    for (size_t i = 0; i < utf8.size();)
    {
        unsigned char c = (unsigned char)utf8[i];
        if (c < 0x80)
        {
            out += (char)c;
            i++;
            continue;
        }
        unsigned int cp = 0;
        int len = 0;
        if ((c & 0xE0) == 0xC0) cp = c & 0x1F, len = 2;
        else if ((c & 0xF0) == 0xE0) cp = c & 0x0F, len = 3;
        else if ((c & 0xF8) == 0xF0) cp = c & 0x07, len = 4;
        else
        {
            i++; // a stray byte: dropped
            continue;
        }
        if (i + len > utf8.size()) break;
        bool ok = true;
        for (int k = 1; k < len; k++)
        {
            unsigned char cc = (unsigned char)utf8[i + k];
            if ((cc & 0xC0) != 0x80) ok = false;
            cp = (cp << 6) | (cc & 0x3F);
        }
        i += ok ? len : 1;
        if (!ok) continue;
        char buf[16];
        if (cp >= 0x10000)
        {
            cp -= 0x10000;
            std::snprintf(buf, sizeof buf, "\\u%04x\\u%04x", 0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        }
        else
        {
            std::snprintf(buf, sizeof buf, "\\u%04x", cp);
        }
        out += buf;
    }
    return out;
}

} // namespace

extern "C" {

JNIEXPORT jint JNICALL Java_io_github_saint1406_atlastaker_OcrEngine_nativeLoad(JNIEnv* env, jclass, jstring dir, jint threads)
{
    std::lock_guard<std::mutex> guard(lock);
    try
    {
        const char* path = env->GetStringUTFChars(dir, nullptr);
        std::string where(path ? path : "");
        if (path) env->ReleaseStringUTFChars(dir, path);
        if (!engine) engine = new atlas::Ocr();
        const int r = engine->load(where, threads);
        if (r != 0)
        {
            LOGE("models did not load: %d", r);
            delete engine;
            engine = nullptr;
        }
        return r;
    }
    catch (const std::bad_alloc&)
    {
        delete engine;
        engine = nullptr;
        return -100;
    }
    catch (...)
    {
        delete engine;
        engine = nullptr;
        return -101;
    }
}

JNIEXPORT void JNICALL Java_io_github_saint1406_atlastaker_OcrEngine_nativeRelease(JNIEnv*, jclass)
{
    std::lock_guard<std::mutex> guard(lock);
    delete engine;
    engine = nullptr;
}

JNIEXPORT void JNICALL Java_io_github_saint1406_atlastaker_OcrEngine_nativeCancel(JNIEnv*, jclass, jboolean on)
{
    cancelled.store(on == JNI_TRUE);
}

/**
 * rgba: a direct buffer of width × height RGBA pixels (Bitmap.copyPixelsToBuffer). The page as read
 * (stretched when dim, turned upright) is written back into it, width and height swapped when turned
 * by 90°; the JSON says how it turned and what it found.
 */
JNIEXPORT jstring JNICALL Java_io_github_saint1406_atlastaker_OcrEngine_nativeRun(JNIEnv* env, jclass, jobject rgba, jint width, jint height, jboolean autoRotate)
{
    std::lock_guard<std::mutex> guard(lock);
    std::string json;
    try
    {
        if (!engine || !engine->loaded())
        {
            json = failure("model");
        }
        else
        {
            unsigned char* pixels = (unsigned char*)env->GetDirectBufferAddress(rgba);
            const jlong capacity = env->GetDirectBufferCapacity(rgba);
            if (!pixels || width < 16 || height < 16 || width > 8000 || height > 8000 || capacity < (jlong)width * height * 4)
            {
                json = failure("input");
            }
            else
            {
                cv::Mat wrapped(height, width, CV_8UC4, pixels);
                cv::Mat rgb;
                cv::cvtColor(wrapped, rgb, cv::COLOR_RGBA2RGB);
                cancelled.store(false);
                atlas::OcrResult r = engine->run(rgb, autoRotate == JNI_TRUE, &cancelled);
                if (r.cancelled)
                {
                    json = failure("cancelled");
                }
                else
                {
                    // what was read goes back to Java in the buffer's place (same number of pixels)
                    cv::Mat back(rgb.rows, rgb.cols, CV_8UC4, pixels);
                    cv::cvtColor(rgb, back, cv::COLOR_RGB2RGBA);
                    json = "{\"ok\":true,\"rotation\":" + std::to_string(r.rotation) + ",\"enhanced\":" + (r.enhanced ? "true" : "false") + ",\"width\":" + std::to_string(r.width) + ",\"height\":" + std::to_string(r.height) + ",\"timings\":{\"enhance\":" + num(r.msEnhance, 0) + ",\"detect\":" + num(r.msDetect, 0) + ",\"orient\":" + num(r.msOrient, 0) + ",\"recognize\":" + num(r.msRecognize, 0) + "},\"items\":[";
                    for (size_t i = 0; i < r.items.size(); i++)
                    {
                        const atlas::TextItem& it = r.items[i];
                        if (i) json += ',';
                        json += "{\"box\":[";
                        for (int k = 0; k < 4; k++)
                        {
                            if (k) json += ',';
                            json += "[" + num(it.quad[k].x, 1) + "," + num(it.quad[k].y, 1) + "]";
                        }
                        json += "],\"text\":";
                        quote(json, it.text);
                        json += ",\"score\":" + num(it.score, 3) + "}";
                    }
                    json += "]}";
                }
            }
        }
    }
    catch (const std::bad_alloc&)
    {
        json = failure("memory");
    }
    catch (...)
    {
        json = failure("internal");
    }
    return env->NewStringUTF(asciiJson(json).c_str());
}

} // extern "C"
