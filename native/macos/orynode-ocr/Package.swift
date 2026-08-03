// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OrynodeOCR",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "orynode-ocr", targets: ["OrynodeOCR"]),
  ],
  targets: [
    .executableTarget(
      name: "OrynodeOCR",
      path: "Sources/OrynodeOCR"
    ),
  ]
)
