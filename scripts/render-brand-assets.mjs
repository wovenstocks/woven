import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import sharp from "sharp"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const brandDirectory = path.join(projectRoot, "assets", "brand")
const newsreaderPath = path.join(
  projectRoot,
  "node_modules",
  "@fontsource-variable",
  "newsreader",
  "files",
  "newsreader-latin-wght-normal.woff2",
)

const [newsreader, mark] = await Promise.all([
  readFile(newsreaderPath),
  readFile(path.join(brandDirectory, "woven-mark-v1.svg")),
])

const wordmark = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
    <style>
      @font-face {
        font-family: "Woven Newsreader";
        src: url("data:font/woff2;base64,${newsreader.toString("base64")}") format("woff2");
        font-style: normal;
        font-weight: 200 800;
      }
    </style>
    <text
      x="250"
      y="282"
      fill="#F3F0E8"
      font-family="Woven Newsreader, Georgia, serif"
      font-size="92"
      font-weight="450"
      letter-spacing="-2.4"
    >Woven Stocks</text>
  </svg>
`)

await Promise.all([
  sharp(mark)
    .resize(400, 400)
    .png({ compressionLevel: 9, palette: true, quality: 100 })
    .toFile(path.join(brandDirectory, "woven-x-avatar-v1.png")),
  sharp(path.join(brandDirectory, "woven-x-banner-art-v1.png"))
    .resize({ width: 1500, height: 500, fit: "cover", position: "centre" })
    .composite([{ input: wordmark, left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path.join(brandDirectory, "woven-x-banner-v1.png")),
])

console.log("Rendered Woven X avatar (400x400) and banner (1500x500)")
