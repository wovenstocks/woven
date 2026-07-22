import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const arguments_ = process.argv.slice(2)
const unexpectedArguments = arguments_.filter((argument) => argument !== "--check")
if (unexpectedArguments.length > 0) {
  throw new Error(`Unexpected argument: ${unexpectedArguments[0]}`)
}
const checkOnly = arguments_.includes("--check")

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), "..")
const publicDirectory = path.join(projectRoot, "public")
const sourcePath = path.join(projectRoot, "assets", "source", "woven-hero-folio.png")
const manifestPath = path.join(projectRoot, "assets", "source", "woven-hero-folio.manifest.json")
const widths = [720, 1280, 1586]
const toManifestPath = (filePath) => path.relative(projectRoot, filePath).split(path.sep).join("/")
const sourceRelativePath = toManifestPath(sourcePath)
const manifestRelativePath = toManifestPath(manifestPath)
const hash = (contents) => createHash("sha256").update(contents).digest("hex")

if (checkOnly) {
  const mismatches = []
  let manifest

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    mismatches.push(manifestRelativePath)
  }

  if (manifest) {
    const [scriptContents, sourceContents] = await Promise.all([
      readFile(scriptPath),
      readFile(sourcePath),
    ])

    if (manifest.schemaVersion !== 1) mismatches.push(`${manifestRelativePath}:schema`)
    if (manifest.generator?.path !== toManifestPath(scriptPath)) {
      mismatches.push(`${manifestRelativePath}:generator-path`)
    }
    if (manifest.generator?.sha256 !== hash(scriptContents)) {
      mismatches.push(`${manifestRelativePath}:generator-hash`)
    }
    if (manifest.source?.path !== sourceRelativePath) {
      mismatches.push(`${manifestRelativePath}:source-path`)
    }
    if (manifest.source?.sha256 !== hash(sourceContents)) {
      mismatches.push(`${manifestRelativePath}:source-hash`)
    }

    const expectedOutputNames = [
      ...widths.flatMap((width) => [
        `woven-hero-folio-${width}.jpg`,
        `woven-hero-folio-${width}.webp`,
        `woven-hero-folio-${width}.avif`,
      ]),
    ]
    const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : []
    const outputsByPath = new Map(outputs.map((output) => [output?.path, output]))

    if (outputs.length !== expectedOutputNames.length) {
      mismatches.push(`${manifestRelativePath}:outputs`)
    }

    for (const fileName of expectedOutputNames) {
      const relativePath = `public/${fileName}`
      const output = outputsByPath.get(relativePath)
      if (!output) {
        mismatches.push(relativePath)
        continue
      }

      try {
        const contents = await readFile(path.join(projectRoot, ...relativePath.split("/")))
        if (output.sha256 !== hash(contents) || output.bytes !== contents.byteLength) {
          mismatches.push(relativePath)
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        mismatches.push(relativePath)
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Generated image assets are missing or stale: ${[...new Set(mismatches)].join(", ")}. Run npm run assets:images.`,
    )
  }

  console.log("Generated image assets match the tracked source artwork and manifest")
} else {
  const { default: sharp } = await import("sharp")
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

  const outputs = await Promise.all(
    outputJobs.map(async ({ fileName, render }) => ({
      fileName,
      filePath: path.join(publicDirectory, fileName),
      contents: await render(),
    })),
  )

  await Promise.all(outputs.map((output) => writeFile(output.filePath, output.contents)))

  const [scriptContents, sourceContents] = await Promise.all([
    readFile(scriptPath),
    readFile(sourcePath),
  ])
  const manifest = {
    schemaVersion: 1,
    generator: {
      path: toManifestPath(scriptPath),
      sha256: hash(scriptContents),
    },
    source: {
      path: sourceRelativePath,
      sha256: hash(sourceContents),
    },
    outputs: outputs.map((output) => ({
      path: toManifestPath(output.filePath),
      sha256: hash(output.contents),
      bytes: output.contents.byteLength,
    })),
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log("Generated responsive hero assets and their integrity manifest")
}
