// ATLAS scanner: text recognition on the phone with PaddleOCR v5 (the mobile text detector and the
// East Slavic recognizer, which reads Russian, Ukrainian, Belarusian and English with one model) on
// ncnn. Pre- and post-processing follow ncnn's PP-OCRv5 example (BSD-3-Clause, © Tencent) as used by
// DroidOCR (Apache-2.0); the desktop prototype of this file checked it on test pages
// (docs/scanner-ocr.md).

#pragma once

#include <atomic>
#include <string>
#include <vector>

#include <opencv2/core/core.hpp>

#include "net.h"

namespace atlas {

struct TextItem {
    cv::Point2f quad[4]; // tl, tr, br, bl along the text, in the page's pixels
    std::string text;    // UTF-8
    float score;         // the recognizer's mean certainty over the letters, 0…1
};

struct OcrResult {
    std::vector<TextItem> items;
    int rotation = 0;     // how far the page was turned clockwise to stand upright: 0, 90, 180, 270
    bool enhanced = false; // the page was too dim or flat and was stretched to black…white first
    int width = 0;
    int height = 0;
    double msEnhance = 0, msDetect = 0, msOrient = 0, msRecognize = 0;
    bool cancelled = false;
};

class Ocr {
public:
    /** dir holds the two models and the dictionary; threads: for the detector and the lines. 0 = ok. */
    int load(const std::string& dir, int threads);
    bool loaded() const { return ready; }
    void release();

    /**
     * Reads a page. rgb: 8-bit, 3 channels; it is changed in place — stretched when dim and turned
     * upright — so that the boxes fit what the caller keeps. cancel: checked between lines.
     */
    OcrResult run(cv::Mat& rgb, bool autoRotate, const std::atomic<bool>* cancel);

    int detectSize = 960; // the detector sees the page at most this large (longer side)

private:
    struct Box {
        cv::Point2f quad[4];
        float score;
    };

    std::vector<Box> detect(const cv::Mat& rgb);
    cv::Mat crop(const cv::Mat& rgb, const cv::Point2f quad[4], bool flip) const;
    float readLine(const cv::Mat& line, std::string* text);
    int orientation(const cv::Mat& rgb, const std::vector<Box>& boxes);

    ncnn::Net det;
    ncnn::Net rec;
    std::vector<std::string> chars; // the dictionary, then " ": the recognizer's classes after "blank"
    int threads = 4;
    bool ready = false;
};

/** Dim or low-contrast photo → stretched to the full range (a little brighter in the dark). */
bool enhance(cv::Mat& rgb);

} // namespace atlas
