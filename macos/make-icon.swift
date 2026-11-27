// Chan to Yare のアイコン (1024px PNG) を描く。build.sh から呼ばれる。
//
//   swiftc -o make-icon make-icon.swift && ./make-icon out.png
//
// 意匠は public/favicon.svg (32px の格子): 左に太い帯 (Claude の番)、右に細い線と点 (あなたの番)。
// 色は Nebula テーマ (public/themes.css) に合わせる:
//   背景 = 赤紫がかった闇 (hue 318)、帯 = オーキッド (hue 325)、線と点 = ミント (hue 165)

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// macOS のアイコン格子: 1024 のキャンバスに 824 の本体、角丸 185
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)

// 落ち影
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0, 0, 0, 0.45))
ctx.addPath(shape)
ctx.setFillColor(rgb(24, 19, 26))
ctx.fillPath()
ctx.restoreGState()

// 背景: 上が少し明るい赤紫の闇
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let ground = CGGradient(
  colorsSpace: space, colors: [rgb(50, 30, 56), rgb(30, 18, 34), rgb(17, 9, 20)] as CFArray,
  locations: [0, 0.55, 1])!
ctx.drawLinearGradient(ground, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

// オーロラ: 左にオーキッド、右にミントのにじみ
func glow(_ center: CGPoint, _ radius: CGFloat, _ color: CGColor) {
  let g = CGGradient(colorsSpace: space, colors: [color, color.copy(alpha: 0)!] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
}
glow(CGPoint(x: 330, y: 560), 420, rgb(206, 122, 211, 0.22))
glow(CGPoint(x: 720, y: 470), 330, rgb(100, 234, 183, 0.12))

// 細い格子 (future の見た目)
ctx.setStrokeColor(rgb(223, 156, 226, 0.05))
ctx.setLineWidth(2)
var gx: CGFloat = 100
while gx <= 924 {
  ctx.move(to: CGPoint(x: gx, y: 100)); ctx.addLine(to: CGPoint(x: gx, y: 924))
  ctx.move(to: CGPoint(x: 100, y: gx)); ctx.addLine(to: CGPoint(x: 924, y: gx))
  gx += 824 / 8
}
ctx.strokePath()
ctx.restoreGState()

// 縁の光
ctx.saveGState()
ctx.addPath(shape)
ctx.setStrokeColor(rgb(255, 255, 255, 0.10))
ctx.setLineWidth(4)
ctx.strokePath()
ctx.restoreGState()

// favicon の 32px 格子 → 本体 824px (1単位 = 25.75px)
let unit = body.width / 32
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: body.minX + x * unit, y: body.maxY - y * unit) }

// 左の帯 (Claude): M6 16 h9、太さ 4、丸い端
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 60, color: rgb(206, 122, 211, 0.75))
ctx.setLineCap(.round)
ctx.setLineWidth(4 * unit)
ctx.setStrokeColor(rgb(214, 136, 219))
ctx.move(to: p(6, 16)); ctx.addLine(to: p(15, 16))
ctx.strokePath()
ctx.restoreGState()
// 帯の上側に明るい筋
ctx.saveGState()
ctx.setLineCap(.round)
ctx.setLineWidth(1.1 * unit)
ctx.setStrokeColor(rgb(240, 200, 242, 0.55))
ctx.move(to: p(6.6, 15.1)); ctx.addLine(to: p(13.2, 15.1))
ctx.strokePath()
ctx.restoreGState()

// 右の線と点 (あなたの番): M19 16 h7 (太さ 2)、点は (17, 16) 半径 2.5
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 50, color: rgb(100, 234, 183, 0.8))
ctx.setLineCap(.round)
ctx.setLineWidth(2 * unit)
ctx.setStrokeColor(rgb(100, 234, 183))
ctx.move(to: p(19, 16)); ctx.addLine(to: p(26, 16))
ctx.strokePath()
ctx.setFillColor(rgb(100, 234, 183))
let dot = p(17, 16)
ctx.fillEllipse(in: CGRect(x: dot.x - 2.5 * unit, y: dot.y - 2.5 * unit, width: 5 * unit, height: 5 * unit))
ctx.restoreGState()

let image = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(out)") }
print("wrote \(out)")
