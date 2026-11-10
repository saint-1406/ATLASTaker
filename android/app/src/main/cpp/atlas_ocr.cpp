// Tencent is pleased to support the open source community by making ncnn available.
// Copyright (C) 2025 THL A29 Limited, a Tencent company. All rights reserved.
// Licensed under the BSD 3-Clause License; see android/app/src/main/cpp/LICENSE-ncnn-example.txt.
//
// The detector's and recognizer's pre- and post-processing come from ncnn's PP-OCRv5 example
// (nihui/ncnn-android-ppocrv5, as carried in DroidOCR's ppocrv5_full.cpp). ATLAS's changes: PaddleOCR's
// unclip instead of a fixed enlargement, the space as the recognizer's last class, the page's
// orientation (0/90/180/270), stretching of dim photos, cancelling, and timings.

#include "atlas_ocr.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>

#include <opencv2/imgproc/imgproc.hpp>

#include "cpu.h"

namespace atlas {

namespace {

double now()
{
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

float dist(const cv::Point2f& a, const cv::Point2f& b)
{
    return std::hypot(a.x - b.x, a.y - b.y);
}

/** tl, tr, br, bl of a box lying (more or less) level. */
void order(const cv::Point2f in[4], cv::Point2f out[4])
{
    int tl = 0, tr = 0, br = 0, bl = 0;
    for (int i = 1; i < 4; i++)
    {
        if (in[i].x + in[i].y < in[tl].x + in[tl].y) tl = i;
        if (in[i].x + in[i].y > in[br].x + in[br].y) br = i;
        if (in[i].x - in[i].y > in[tr].x - in[tr].y) tr = i;
        if (in[i].x - in[i].y < in[bl].x - in[bl].y) bl = i;
    }
    out[0] = in[tl];
    out[1] = in[tr];
    out[2] = in[br];
    out[3] = in[bl];
}

float longSide(const cv::Point2f q[4])
{
    return std::max(dist(q[0], q[1]), dist(q[0], q[3]));
}

} // namespace

bool enhance(cv::Mat& rgb)
{
    int hist[256] = {0};
    const int n = rgb.rows * rgb.cols;
    for (int y = 0; y < rgb.rows; y++)
    {
        const unsigned char* p = rgb.ptr<unsigned char>(y);
        for (int x = 0; x < rgb.cols; x++, p += 3) hist[(p[0] * 77 + p[1] * 150 + p[2] * 29) >> 8]++;
    }
    double sum = 0;
    for (int i = 0; i < 256; i++) sum += (double)i * hist[i];
    const double mean = sum / std::max(n, 1);
    auto percentile = [&](double q) {
        long long acc = 0;
        const long long want = (long long)(n * q);
        for (int i = 0; i < 256; i++)
        {
            acc += hist[i];
            if (acc > want) return i;
        }
        return 255;
    };
    // paper that is white enough needs nothing
    if (percentile(0.99) >= 170 && mean >= 100) return false;
    const int lo = percentile(0.005);
    const int hi = std::max(percentile(0.995), lo + 24);
    const double gamma = mean < 90 ? 0.75 : 1.0;
    unsigned char lut[256];
    for (int i = 0; i < 256; i++)
    {
        const double v = std::min(1.0, std::max(0.0, (double)(i - lo) / (hi - lo)));
        lut[i] = (unsigned char)std::lround(std::pow(v, gamma) * 255.0);
    }
    for (int y = 0; y < rgb.rows; y++)
    {
        unsigned char* p = rgb.ptr<unsigned char>(y);
        for (int x = 0; x < rgb.cols * 3; x++) p[x] = lut[p[x]];
    }
    return true;
}

int Ocr::load(const std::string& dir, int wantThreads)
{
    release();
    threads = wantThreads > 0 ? wantThreads : std::max(1, ncnn::get_big_cpu_count());

    det.opt.num_threads = threads;
    det.opt.use_vulkan_compute = false;
    // the recognizer keeps 32-bit arithmetic: half precision saves little on short lines and costs letters
    rec.opt.num_threads = 1; // lines are read in parallel, one thread each
    rec.opt.use_vulkan_compute = false;
    rec.opt.use_fp16_arithmetic = false;

    if (det.load_param((dir + "/PP_OCRv5_mobile_det.ncnn.param").c_str()) != 0) return -1;
    if (det.load_model((dir + "/PP_OCRv5_mobile_det.ncnn.bin").c_str()) != 0) return -2;
    if (rec.load_param((dir + "/eslav_ppocrv5_rec.ncnn.param").c_str()) != 0) return -3;
    if (rec.load_model((dir + "/eslav_ppocrv5_rec.ncnn.bin").c_str()) != 0) return -4;

    chars.clear();
    std::ifstream dict(dir + "/ppocrv5_eslav_dict.txt", std::ios::binary);
    if (!dict) return -5;
    std::string line;
    while (std::getline(dict, line))
    {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
        if (!line.empty()) chars.push_back(line);
    }
    if (chars.empty()) return -5;
    chars.push_back(" "); // PaddleOCR's use_space_char: the last class is a space
    ready = true;
    return 0;
}

void Ocr::release()
{
    det.clear();
    rec.clear();
    chars.clear();
    ready = false;
}

std::vector<Ocr::Box> Ocr::detect(const cv::Mat& rgb)
{
    const int w = rgb.cols;
    const int h = rgb.rows;
    const float scale = std::min(1.f, (float)detectSize / std::max(w, h));
    const int dw = std::max(32, (int)std::lround(w * scale / 32) * 32);
    const int dh = std::max(32, (int)std::lround(h * scale / 32) * 32);
    const float sx = (float)dw / w;
    const float sy = (float)dh / h;

    ncnn::Mat in = ncnn::Mat::from_pixels_resize(rgb.data, ncnn::Mat::PIXEL_RGB2BGR, w, h, (int)rgb.step[0], dw, dh);
    const float mean[3] = {0.485f * 255.f, 0.456f * 255.f, 0.406f * 255.f};
    const float norm[3] = {1 / 0.229f / 255.f, 1 / 0.224f / 255.f, 1 / 0.225f / 255.f};
    in.substract_mean_normalize(mean, norm);

    ncnn::Extractor ex = det.create_extractor();
    ex.input("in0", in);
    ncnn::Mat out;
    ex.extract("out0", out);

    cv::Mat prob(out.h, out.w, CV_32FC1, (float*)out.data);
    cv::Mat bitmap = prob > 0.3f; // 255 where text is likely

    std::vector<std::vector<cv::Point> > contours;
    cv::findContours(bitmap, contours, cv::RETR_LIST, cv::CHAIN_APPROX_SIMPLE);
    if (contours.size() > 1000) contours.resize(1000);

    std::vector<Box> boxes;
    for (const std::vector<cv::Point>& c : contours)
    {
        if (c.size() < 4) continue;
        cv::RotatedRect rr = cv::minAreaRect(c);
        if (std::min(rr.size.width, rr.size.height) < 3) continue;

        // the box's mean probability (DBNet's "fast" score)
        cv::Rect r = cv::boundingRect(c) & cv::Rect(0, 0, prob.cols, prob.rows);
        if (r.width <= 0 || r.height <= 0) continue;
        cv::Mat mask = cv::Mat::zeros(r.height, r.width, CV_8UC1);
        std::vector<std::vector<cv::Point> > shifted(1);
        for (const cv::Point& p : c) shifted[0].push_back(p - r.tl());
        cv::fillPoly(mask, shifted, cv::Scalar(1));
        const float score = (float)cv::mean(prob(r), mask)[0];
        if (score < 0.6f) continue;

        // unclip: grow by area × 1.5 / perimeter on every side (PaddleOCR's unclip_ratio)
        const float rw = rr.size.width;
        const float rh = rr.size.height;
        const float d = rw * rh * 1.5f / (2 * (rw + rh));
        rr.size.width = rw + 2 * d;
        rr.size.height = rh + 2 * d;
        if (std::min(rr.size.width, rr.size.height) < 5) continue;

        cv::Point2f pts[4];
        rr.points(pts);
        for (cv::Point2f& p : pts)
        {
            p.x = std::min(std::max(p.x / sx, 0.f), (float)(w - 1));
            p.y = std::min(std::max(p.y / sy, 0.f), (float)(h - 1));
        }
        Box box;
        order(pts, box.quad);
        box.score = score;
        boxes.push_back(box);
    }
    return boxes;
}

cv::Mat Ocr::crop(const cv::Mat& rgb, const cv::Point2f quadIn[4], bool flip) const
{
    cv::Point2f q[4] = {quadIn[0], quadIn[1], quadIn[2], quadIn[3]};
    float bw = std::max(dist(q[1], q[0]), dist(q[2], q[3]));
    float bh = std::max(dist(q[3], q[0]), dist(q[2], q[1]));
    if (bw < 2 || bh < 2) return cv::Mat();
    if (bh > bw * 1.5f)
    {
        // a standing box: text written downwards (or a column of single letters)
        cv::Point2f r[4] = {q[1], q[2], q[3], q[0]};
        std::copy(r, r + 4, q);
        std::swap(bw, bh);
    }
    const int th = 48;
    const int tw = std::max(16, std::min((int)std::lround(bw * th / bh), 3200));
    cv::Point2f dst[4] = {cv::Point2f(0, 0), cv::Point2f((float)tw, 0), cv::Point2f((float)tw, (float)th), cv::Point2f(0, (float)th)};
    if (flip)
    {
        std::swap(dst[0], dst[2]);
        std::swap(dst[1], dst[3]);
    }
    cv::Mat m = cv::getPerspectiveTransform(q, dst);
    cv::Mat line;
    cv::warpPerspective(rgb, line, m, cv::Size(tw, th), cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    return line;
}

float Ocr::readLine(const cv::Mat& line, std::string* text)
{
    ncnn::Mat in = ncnn::Mat::from_pixels(line.data, ncnn::Mat::PIXEL_RGB2BGR, line.cols, line.rows, (int)line.step[0]);
    const float mean[3] = {127.5f, 127.5f, 127.5f};
    const float norm[3] = {1 / 127.5f, 1 / 127.5f, 1 / 127.5f};
    in.substract_mean_normalize(mean, norm);

    ncnn::Extractor ex = rec.create_extractor();
    ex.input("in0", in);
    ncnn::Mat out;
    ex.extract("out0", out);

    // CTC: the best class at each step; repeats and "blank" (0) fall away
    double sum = 0;
    int count = 0;
    int last = 0;
    for (int i = 0; i < out.h; i++)
    {
        const float* p = out.row(i);
        int best = 0;
        for (int j = 1; j < out.w; j++)
            if (p[j] > p[best]) best = j;
        if (best != 0 && best != last)
        {
            if (text && best - 1 < (int)chars.size()) *text += chars[best - 1];
            sum += p[best];
            count++;
        }
        last = best;
    }
    return count ? (float)(sum / count) : 0.f;
}

int Ocr::orientation(const cv::Mat& rgb, const std::vector<Box>& boxes)
{
    if (boxes.empty()) return 0;
    double standing = 0, lying = 0;
    for (const Box& b : boxes)
    {
        const float bw = dist(b.quad[1], b.quad[0]);
        const float bh = dist(b.quad[3], b.quad[0]);
        if (bh > bw * 1.5f) standing += bh;
        else if (bw > bh * 1.5f) lying += bw;
    }
    const bool sideways = standing > lying * 1.2;

    // up or down: whichever way the recognizer is surer of, on the longest few lines
    std::vector<const Box*> probe;
    for (const Box& b : boxes) probe.push_back(&b);
    std::sort(probe.begin(), probe.end(), [](const Box* a, const Box* b) { return longSide(a->quad) > longSide(b->quad); });
    if (probe.size() > 4) probe.resize(4);
    double up = 0, down = 0;
    for (const Box* b : probe)
    {
        cv::Point2f q[4] = {b->quad[0], b->quad[1], b->quad[2], b->quad[3]};
        if (sideways)
        {
            cv::Point2f r[4] = {q[1], q[2], q[3], q[0]};
            std::copy(r, r + 4, q);
        }
        cv::Mat line = crop(rgb, q, false);
        if (line.empty()) continue;
        line = line(cv::Rect(0, 0, std::min(480, line.cols), line.rows)).clone(); // a few words tell enough
        cv::Mat turned;
        cv::rotate(line, turned, cv::ROTATE_180);
        up += readLine(line, nullptr);
        down += readLine(turned, nullptr);
    }
    const bool flipped = down > up + 0.03 * probe.size();
    if (sideways) return flipped ? 90 : 270;
    return flipped ? 180 : 0;
}

OcrResult Ocr::run(cv::Mat& rgb, bool autoRotate, const std::atomic<bool>* cancel)
{
    OcrResult result;
    double t = now();
    result.enhanced = enhance(rgb);
    result.msEnhance = now() - t;

    t = now();
    std::vector<Box> boxes = detect(rgb);
    result.msDetect = now() - t;

    if (autoRotate && !(cancel && cancel->load()))
    {
        t = now();
        result.rotation = orientation(rgb, boxes);
        if (result.rotation)
        {
            const int code = result.rotation == 90 ? cv::ROTATE_90_CLOCKWISE : result.rotation == 180 ? cv::ROTATE_180 : cv::ROTATE_90_COUNTERCLOCKWISE;
            cv::Mat turned;
            cv::rotate(rgb, turned, code);
            rgb = turned;
            boxes = detect(rgb);
        }
        result.msOrient = now() - t;
    }
    result.width = rgb.cols;
    result.height = rgb.rows;

    t = now();
    std::vector<TextItem> found(boxes.size());
    std::vector<char> keep(boxes.size(), 0);
#pragma omp parallel for num_threads(threads) schedule(dynamic)
    for (int i = 0; i < (int)boxes.size(); i++)
    {
        if (cancel && cancel->load()) continue;
        cv::Mat line = crop(rgb, boxes[i].quad, false);
        if (line.empty()) continue;
        std::string text;
        const float score = readLine(line, &text);
        if (score < 0.5f || text.find_first_not_of(' ') == std::string::npos) continue;
        std::copy(boxes[i].quad, boxes[i].quad + 4, found[i].quad);
        found[i].text = text;
        found[i].score = score;
        keep[i] = 1;
    }
    for (size_t i = 0; i < boxes.size(); i++)
        if (keep[i]) result.items.push_back(found[i]);
    result.msRecognize = now() - t;
    result.cancelled = cancel && cancel->load();
    return result;
}

} // namespace atlas
