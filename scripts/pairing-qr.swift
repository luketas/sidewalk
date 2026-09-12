import Foundation
import CoreImage
import AppKit

guard CommandLine.arguments.count == 3 else { fatalError("Usage: swift pairing-qr.swift pairing.json pairing.png") }
let payload = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(payload, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
let code = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
let margin: CGFloat = 32
let bounds = CGRect(x: 0, y: 0, width: code.extent.width + margin * 2, height: code.extent.height + margin * 2)
let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: bounds)
let image = code.transformed(by: CGAffineTransform(translationX: margin, y: margin)).composited(over: white)
let context = CIContext()
let bitmap = NSBitmapImageRep(cgImage: context.createCGImage(image, from: image.extent)!)
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: CommandLine.arguments[2])
print("Private connection QR generated. It expires with the original pairing code.")
