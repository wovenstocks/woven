import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import sharp from "sharp"

const arguments_ = process.argv.slice(2)
const unexpectedArguments = arguments_.filter((argument) => argument !== "--check")
if (unexpectedArguments.length > 0) {
  throw new Error(`Unexpected argument: ${unexpectedArguments[0]}`)
}
const checkOnly = arguments_.includes("--check")

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const publicDirectory = path.join(projectRoot, "public")
const sourcePath = path.join(projectRoot, "assets", "source", "woven-hero-folio.png")
const widths = [720, 1280, 1586]
const source = await sharp(sourcePath).rotate().toBuffer()

const outputJobs = widths.flatMap((width) => {
  const resized = () => sharp(source).resize({ width, withoutEnlargement: true })

  return [
    {
      fileName: `woven-hero-folio-${width}.jpg`,
      render: () => resized().jpeg({ quality: 86, mozjpeg: true, progressive: true }).toBuffer(),
    },
    {
      fileName: `woven-hero-folio-${width}.webp`,
      render: () => resized().webp({ quality: 84, effort: 6 }).toBuffer(),
    },
    {
      fileName: `woven-hero-folio-${width}.avif`,
      render: () => resized().avif({ quality: 60, effort: 6 }).toBuffer(),
    },
  ]
})

outputJobs.push({
  fileName: "social-card.jpg",
  render: () =>
    sharp(source)
      .resize({ width: 1200, height: 630, fit: "cover", position: "centre" })
      .jpeg({ quality: 88, mozjpeg: true, progressive: true })
      .toBuffer(),
})

const outputs = await Promise.all(
  outputJobs.map(async ({ fileName, render }) => ({
    fileName,
    filePath: path.join(publicDirectory, fileName),
    contents: await render(),
  })),
)

if (checkOnly) {
  const mismatches = []

  for (const output of outputs) {
    try {
      const current = await readFile(output.filePath)
      if (!current.equals(output.contents)) mismatches.push(output.fileName)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      mismatches.push(output.fileName)
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Generated image assets are missing or stale: ${mismatches.join(", ")}. Run npm run assets:images.`,
    )
  }

  console.log("Generated image assets match the tracked source artwork")
} else {
  await Promise.all(outputs.map((output) => writeFile(output.filePath, output.contents)))
  console.log("Generated responsive hero assets and social-card.jpg")
}
