import Foundation
import Vision
import CoreGraphics
import ImageIO

let protocolVersion = 1
let engineName = "apple-vision"
let engineVersion = "vision-framework"

struct HelperRequest: Decodable {
  let protocolVersion: Int
  let requestId: String
  let pageNumber: Int
  let imagePath: String
  let mimeType: String?
  let width: Int?
  let height: Int?
  let languages: [String]?
  let recognitionLevel: String?
}

struct BBox: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Block: Encodable {
  let text: String
  let bbox: BBox
  let confidence: Double?
  let readingOrder: Int
  let language: String?
}

enum Output {
  static func write(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8) else {
      fputs("{\"ok\":false,\"code\":\"OCR_HELPER_PROTOCOL_ERROR\"}\n", stdout)
      return
    }
    fputs(line + "\n", stdout)
    fflush(stdout)
  }

  static func fail(requestId: String?, pageNumber: Int?, code: String, message: String? = nil) {
    var obj: [String: Any] = [
      "protocolVersion": protocolVersion,
      "ok": false,
      "code": code,
    ]
    if let requestId { obj["requestId"] = requestId }
    if let pageNumber { obj["pageNumber"] = pageNumber }
    if let message { obj["message"] = message }
    write(obj)
  }
}

func makeProbeImage() -> CGImage? {
  let width = 8
  let height = 8
  let bytesPerRow = width * 4
  var data = [UInt8](repeating: 255, count: height * bytesPerRow)
  guard let ctx = CGContext(
    data: &data,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    return nil
  }
  return ctx.makeImage()
}

func visionRecognitionAvailable() -> (Bool, String?) {
  guard let image = makeProbeImage() else {
    return (false, "probe image failed")
  }
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .fast
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  do {
    try handler.perform([request])
    return (true, nil)
  } catch {
    return (false, "Vision text recognition unavailable")
  }
}

func printCapabilities() {
  let (available, reason) = visionRecognitionAvailable()
  var payload: [String: Any] = [
    "protocolVersion": protocolVersion,
    "ok": true,
    "available": available,
    "engine": engineName,
    "engineVersion": engineVersion,
    "languages": ["zh-Hans", "en-US"],
    "boundingBoxes": true,
  ]
  if let reason, !available {
    payload["reason"] = reason
  }
  Output.write(payload)
}

func printVersion() {
  Output.write([
    "protocolVersion": protocolVersion,
    "ok": true,
    "engine": engineName,
    "engineVersion": engineVersion,
  ])
}

func loadCGImage(path: String) -> CGImage? {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

/// Vision bbox is bottom-left origin; convert to top-left normalized and clamp to [0,1].
func topLeftBBox(from box: CGRect) -> BBox {
  let x0 = min(max(Double(box.origin.x), 0), 1)
  let y0 = min(max(Double(1.0 - box.origin.y - box.size.height), 0), 1)
  let w0 = max(Double(box.size.width), 0)
  let h0 = max(Double(box.size.height), 0)
  return BBox(
    x: x0,
    y: y0,
    width: min(w0, 1 - x0),
    height: min(h0, 1 - y0)
  )
}

func recognize(request: HelperRequest) {
  if request.protocolVersion != protocolVersion {
    Output.fail(requestId: request.requestId, pageNumber: request.pageNumber, code: "OCR_HELPER_PROTOCOL_ERROR", message: "protocol mismatch")
    return
  }

  guard let cgImage = loadCGImage(path: request.imagePath) else {
    Output.fail(requestId: request.requestId, pageNumber: request.pageNumber, code: "OCR_HELPER_PROTOCOL_ERROR", message: "image load failed")
    return
  }

  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  let textRequest = VNRecognizeTextRequest()
  textRequest.recognitionLevel = request.recognitionLevel == "accurate" ? .accurate : .fast
  textRequest.usesLanguageCorrection = true
  if let languages = request.languages, !languages.isEmpty {
    textRequest.recognitionLanguages = languages
  } else {
    textRequest.recognitionLanguages = ["zh-Hans", "en-US"]
  }

  do {
    try handler.perform([textRequest])
  } catch {
    Output.fail(requestId: request.requestId, pageNumber: request.pageNumber, code: "OCR_UNAVAILABLE", message: "vision perform failed")
    return
  }

  let observations = textRequest.results ?? []
  var blocks: [[String: Any]] = []
  var order = 0
  for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string
    if text.isEmpty { continue }
    if text.count > 8000 { continue }
    let bbox = topLeftBBox(from: observation.boundingBox)
    blocks.append([
      "text": text,
      "bbox": [
        "x": bbox.x,
        "y": bbox.y,
        "width": bbox.width,
        "height": bbox.height,
      ],
      "confidence": Double(candidate.confidence),
      "readingOrder": order,
    ])
    order += 1
  }

  Output.write([
    "protocolVersion": protocolVersion,
    "requestId": request.requestId,
    "pageNumber": request.pageNumber,
    "ok": true,
    "blocks": blocks,
    "engine": engineName,
    "engineVersion": engineVersion,
    "warnings": [],
  ])
}

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--capabilities") {
  printCapabilities()
  exit(0)
}
if args.contains("--version") {
  printVersion()
  exit(0)
}

// JSONL 会话：逐行 decode → recognize → fflush，不得等 stdin EOF
// （Node HelperSession 在整篇文档结束前保持 stdin 打开）
let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { continue }
  guard let data = trimmed.data(using: .utf8) else {
    Output.fail(requestId: nil, pageNumber: nil, code: "OCR_HELPER_PROTOCOL_ERROR")
    continue
  }
  do {
    let req = try decoder.decode(HelperRequest.self, from: data)
    recognize(request: req)
  } catch {
    Output.fail(
      requestId: nil,
      pageNumber: nil,
      code: "OCR_HELPER_PROTOCOL_ERROR",
      message: "invalid request json"
    )
  }
}
