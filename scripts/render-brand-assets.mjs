import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const arguments_ = process.argv.slice(2)
const unexpectedArguments = arguments_.filter((argument) => argument !== "--check")
if (unexpectedArguments.length > 0) {
  throw new Error(`Unexpected arguments: ${unexpectedArguments.join(", ")}`)
}

const checkOnly = arguments_.includes("--check")
const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), "..")
const sourcePath = path.join(projectRoot, "assets", "brand", "woven-logo-source.png")
const manifestPath = path.join(projectRoot, "assets", "brand", "woven-logo.manifest.json")
const crop = { left: 217, top: 217, width: 820, height: 820 }
const expectedSourceSize = { width: 1254, height: 1254 }
const squareOutputs = [
  { path: "public/favicon-32.png", width: 32, height: 32 },
  { path: "public/favicon-192.png", width: 192, height: 192 },
  { path: "public/favicon-512.png", width: 512, height: 512 },
  { path: "public/apple-touch-icon.png", width: 180, height: 180 },
  { path: "public/woven-token-logo.png", width: 1024, height: 1024 },
  { path: "assets/brand/woven-x-avatar-v2.png", width: 400, height: 400 },
]
const socialOutput = {
  path: "public/woven-social-preview.png",
  width: 1200,
  height: 630,
}
const expectedOutputs = [...squareOutputs, socialOutput]

const toManifestPath = (filePath) => path.relative(projectRoot, filePath).split(path.sep).join("/")
const manifestPathLabel = toManifestPath(manifestPath)
const sourcePathLabel = toManifestPath(sourcePath)
const hash = (contents) => createHash("sha256").update(contents).digest("hex")

if (checkOnly) {
  const mismatches = []
  let manifest

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    mismatches.push(manifestPathLabel)
  }

  if (manifest) {
    const [scriptContents, sourceContents] = await Promise.all([
      readFile(scriptPath),
      readFile(sourcePath),
    ])

    if (manifest.schemaVersion !== 1) mismatches.push(`${manifestPathLabel}:schema`)
    if (manifest.generator?.path !== toManifestPath(scriptPath)) {
      mismatches.push(`${manifestPathLabel}:generator-path`)
    }
    if (manifest.generator?.sha256 !== hash(scriptContents)) {
      mismatches.push(`${manifestPathLabel}:generator-hash`)
    }
    if (manifest.source?.path !== sourcePathLabel) {
      mismatches.push(`${manifestPathLabel}:source-path`)
    }
    if (manifest.source?.sha256 !== hash(sourceContents)) {
      mismatches.push(`${manifestPathLabel}:source-hash`)
    }
    if (JSON.stringify(manifest.crop) !== JSON.stringify(crop)) {
      mismatches.push(`${manifestPathLabel}:crop`)
    }

    const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : []
    const outputsByPath = new Map(outputs.map((output) => [output?.path, output]))
    if (outputs.length !== expectedOutputs.length) {
      mismatches.push(`${manifestPathLabel}:outputs`)
    }

    for (const expected of expectedOutputs) {
      const output = outputsByPath.get(expected.path)
      if (!output) {
        mismatches.push(expected.path)
        continue
      }

      try {
        const contents = await readFile(path.join(projectRoot, ...expected.path.split("/")))
        if (
          output.sha256 !== hash(contents) ||
          output.bytes !== contents.byteLength ||
          output.width !== expected.width ||
          output.height !== expected.height
        ) {
          mismatches.push(expected.path)
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        mismatches.push(expected.path)
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Brand assets are missing or stale: ${[...new Set(mismatches)].join(", ")}. Run npm run brand:render.`,
    )
  }

  console.log("Brand assets match the approved Woven logo and integrity manifest")
} else {
  const { default: sharp } = await import("sharp")
  const metadata = await sharp(sourcePath).metadata()
  if (
    metadata.width !== expectedSourceSize.width ||
    metadata.height !== expectedSourceSize.height
  ) {
    throw new Error(
      `Expected the approved ${expectedSourceSize.width}x${expectedSourceSize.height} logo source, received ${metadata.width}x${metadata.height}.`,
    )
  }

  const croppedLogo = await sharp(sourcePath).extract(crop).png().toBuffer()
  const squareResults = await Promise.all(
    squareOutputs.map(async (output) => ({
      ...output,
      contents: await sharp(croppedLogo)
        .resize(output.width, output.height, { fit: "fill" })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer(),
    })),
  )
  const socialLogo = await sharp(croppedLogo)
    .resize(560, 560, { fit: "fill" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()
  const socialResult = {
    ...socialOutput,
    contents: await sharp({
      create: {
        width: socialOutput.width,
        height: socialOutput.height,
        channels: 3,
        background: "#000000",
      },
    })
      .composite([{ input: socialLogo, left: 320, top: 35 }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  }
  const results = [...squareResults, socialResult]

  await Promise.all(
    results.map((output) =>
      writeFile(path.join(projectRoot, ...output.path.split("/")), output.contents),
    ),
  )

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
      path: sourcePathLabel,
      sha256: hash(sourceContents),
      ...expectedSourceSize,
    },
    crop,
    outputs: results.map((output) => ({
      path: output.path,
      sha256: hash(output.contents),
      bytes: output.contents.byteLength,
      width: output.width,
      height: output.height,
    })),
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log("Rendered Woven favicons, social preview, token logo and X avatar")
}
