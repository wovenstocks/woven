import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { Version as CycloneDxVersion } from "@cyclonedx/cyclonedx-library/Spec"
import { JsonValidator } from "@cyclonedx/cyclonedx-library/Validation"

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const OUTPUT_DIRECTORY = "release-evidence"
const SBOM_FILE = `${OUTPUT_DIRECTORY}/sbom.cdx.json`
const CONTRACT_SBOM_FILE = `${OUTPUT_DIRECTORY}/contracts.cdx.json`
const RELEASE_FILE = `${OUTPUT_DIRECTORY}/release.json`
const MANIFEST_FILE = `${OUTPUT_DIRECTORY}/artifacts.sha256`
const FORGE_STD_COMMIT = "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b"

export const CONTRACT_ARTIFACTS = Object.freeze([
  "contracts/out/BasketFactory.sol/BasketFactory.json",
  "contracts/out/BasketToken.sol/BasketToken.json",
  "contracts/out/CanonicalAssetRegistry.sol/CanonicalAssetRegistry.json",
  "contracts/out/CreatorLicense.sol/CreatorLicense.json",
  "contracts/out/CuratorGuardian.sol/CuratorGuardian.json",
  "contracts/out/DeployCore.s.sol/DeployCore.json",
  "contracts/out/DeployBuyRouter.s.sol/DeployBuyRouter.json",
  "contracts/out/DeployCoreFour.s.sol/DeployCoreFour.json",
  "contracts/out/FeeSplitter.sol/FeeSplitter.json",
  "contracts/out/OneClickBasketRouter.sol/OneClickBasketRouter.json",
  "contracts/out/PancakeV2ExactOutputAdapter.sol/PancakeV2ExactOutputAdapter.json",
  "contracts/out/PancakeV3ExactOutputAdapter.sol/PancakeV3ExactOutputAdapter.json",
  "contracts/out/UniswapV4ExactOutputAdapter.sol/UniswapV4ExactOutputAdapter.json",
])

export const RELEASE_DOCUMENTS = Object.freeze([
  "contracts/SECURITY_PROPERTIES.md",
  "contracts/security-artifacts/SECURITY_WORKFLOW_REPORT.md",
  "contracts/security-artifacts/function-summary-diagram.md",
  "contracts/security-artifacts/inheritance-diagram.md",
  "contracts/security-artifacts/vars-and-auth-diagram.md",
  "docs/DEPLOYMENT.md",
  "docs/DEPLOYMENT_RECORD_TEMPLATE.md",
  "docs/LAUNCH_OPERATOR_RUNBOOK.md",
  "docs/LAUNCH_SIGNING_RECEIPTS_TEMPLATE.json",
  "docs/RELEASE_TRANSACTION_PLAN_TEMPLATE.json",
])

export const RELEASE_TOOLING = Object.freeze([
  "tools/release-console/app.mjs",
  "tools/release-console/core.mjs",
  "tools/release-console/index.html",
  "tools/release-console/prepare-foundry-plan.mjs",
  "tools/release-console/prepare-manifest.mjs",
  "tools/release-console/server.mjs",
  "tools/release-console/styles.css",
])

const BUILD_INPUTS = [
  ".github/slither-requirements.txt",
  ".github/workflows/ci.yml",
  ".node-version",
  "contracts/foundry.toml",
  "package-lock.json",
  "package.json",
  "vercel.json",
  "vite.config.mjs",
]

const ROUTER_CODEHASH_PIN_ENVIRONMENT = Object.freeze([
  "EXPECTED_PROTOCOL_SAFE_CODEHASH",
  "EXPECTED_WOVEN_CODEHASH",
  "EXPECTED_CREATOR_LICENSE_CODEHASH",
  "EXPECTED_ASSET_REGISTRY_CODEHASH",
  "EXPECTED_FEE_SPLITTER_CODEHASH",
  "EXPECTED_CURATOR_GUARDIAN_CODEHASH",
  "EXPECTED_BASKET_FACTORY_CODEHASH",
  "EXPECTED_ONE_CLICK_ROUTER_CODEHASH",
  "EXPECTED_UNISWAP_V4_ADAPTER_CODEHASH",
  "EXPECTED_PANCAKE_V3_ADAPTER_CODEHASH",
  "EXPECTED_USDC_CODEHASH",
  "EXPECTED_USDT_CODEHASH",
  "EXPECTED_USDC_IMPLEMENTATION_CODEHASH",
  "EXPECTED_BSTOCK_BEACON_CODEHASH",
  "EXPECTED_BSTOCK_IMPLEMENTATION_CODEHASH",
  "EXPECTED_NVDAB_CODEHASH",
  "EXPECTED_MSFTB_CODEHASH",
  "EXPECTED_TSLAB_CODEHASH",
  "EXPECTED_QQQB_CODEHASH",
  "EXPECTED_PANCAKE_V3_ROUTER_CODEHASH",
  "EXPECTED_PANCAKE_V3_FACTORY_CODEHASH",
  "EXPECTED_PANCAKE_V3_QUOTER_CODEHASH",
  "EXPECTED_PANCAKE_V3_MSFTB_POOL_CODEHASH",
  "EXPECTED_PANCAKE_V3_QQQB_POOL_CODEHASH",
  "EXPECTED_PANCAKE_V3_STABLE_POOL_CODEHASH",
  "EXPECTED_UNISWAP_V4_POOL_MANAGER_CODEHASH",
  "EXPECTED_UNISWAP_V4_STATE_VIEW_CODEHASH",
  "EXPECTED_UNISWAP_V4_QUOTER_CODEHASH",
  "EXPECTED_UNISWAP_UNIVERSAL_ROUTER_CODEHASH",
  "EXPECTED_UNISWAP_PERMIT2_CODEHASH",
])

const ROUTER_PROBE_ENVIRONMENT = Object.freeze([
  "PROBE_RAW_OUTPUT_NVDAB",
  "PROBE_RAW_OUTPUT_MSFTB",
  "PROBE_RAW_OUTPUT_TSLAB",
  "PROBE_RAW_OUTPUT_QQQB",
  "MAX_PROBE_USDC_IN_NVDAB",
  "MAX_PROBE_USDC_IN_MSFTB",
  "MAX_PROBE_USDC_IN_TSLAB",
  "MAX_PROBE_USDC_IN_QQQB",
])

export function createDeploymentEvidenceRequirements() {
  return {
    schema: "woven-deployment-evidence-requirements/v1",
    deploymentScripts: {
      core: "contracts/script/DeployCore.s.sol:DeployCore",
      buyRouter: "contracts/script/DeployBuyRouter.s.sol:DeployBuyRouter",
      coreFour: "contracts/script/DeployCoreFour.s.sol:DeployCoreFour",
    },
    deployedContracts: [
      "CreatorLicense",
      "CanonicalAssetRegistry",
      "FeeSplitter",
      "CuratorGuardian",
      "BasketFactory",
      "UniswapV4ExactOutputAdapter",
      "PancakeV3ExactOutputAdapter",
      "OneClickBasketRouter",
      "BasketToken:CORE4",
    ],
    compiledButExcludedFromInitialRouteSet: [
      {
        contract: "PancakeV2ExactOutputAdapter",
        reason: "The reviewed initial route set excludes the dust-sized PancakeSwap v2 TSLAB pool.",
      },
    ],
    coreFour: {
      name: "Woven Core Four",
      symbol: "CORE4",
      assetOrder: ["NVDAB", "MSFTB", "TSLAB", "QQQB"],
      displayedUnitPerAsset: "10000000000000000",
      rawUnitDerivation:
        "Each current ERC-8056 token fromUIAmount(1e16), verified by toUIAmount roundtrip.",
      mintFeeBps: 30,
      initialSupplyCap: "1000000000000000000000",
      maximumSupplyCap: "1000000000000000000000000",
      webAddressEnvironment: "VITE_BASKET_CORE4",
      webRawUnitsEnvironment: "VITE_BASKET_CORE4_UNITS_RAW",
    },
    routes: [
      {
        asset: "NVDAB",
        adapter: "UniswapV4ExactOutputAdapter",
        routeIdPreimage: "WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1",
        path: "USDC(fee=2,tickSpacing=1)->USDT->NVDAB(fee=20000,tickSpacing=400),hooks=0",
      },
      {
        asset: "MSFTB",
        adapter: "PancakeV3ExactOutputAdapter",
        routeIdPreimage: "WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1",
        path: "exact-output reverse path MSFTB(fee=2500)->USDT(fee=100)->USDC",
      },
      {
        asset: "TSLAB",
        adapter: "UniswapV4ExactOutputAdapter",
        routeIdPreimage: "WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1",
        path: "USDC(fee=2,tickSpacing=1)->USDT->TSLAB(fee=105,tickSpacing=10),hooks=0",
      },
      {
        asset: "QQQB",
        adapter: "PancakeV3ExactOutputAdapter",
        routeIdPreimage: "WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1",
        path: "exact-output reverse path QQQB(fee=100)->USDT(fee=100)->USDC",
      },
    ],
    codehashPinEnvironment: [...ROUTER_CODEHASH_PIN_ENVIRONMENT],
    quoteProbeEnvironment: [...ROUTER_PROBE_ENVIRONMENT],
    configurationHashEnvironment: ["CONFIRM_ROUTE_CONFIG_HASH", "CONFIRM_CORE_FOUR_CONFIG_HASH"],
    liveRecordRequirements: [
      "deployment transaction and receipt for every deployed contract",
      "runtime code hash and verified-source URL for every deployed contract",
      "route ID, route hash, path or pool keys, adapter, and output token",
      "code-hash pin value, address, chain ID, block number, and UTC observation time",
      "exact-output probe amount, maximum USDC input, quoted input, gas estimate, block number, and UTC time",
      "CORE4 factory count before and after, raw recipe read-back, fee, caps, creator, guardian, and fee recipient",
      "low-value mainnet canary receipt and payer USDC, basket, refund, and router residual-balance deltas",
    ],
  }
}

function normalizeRelativePath(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/")

  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Release path must stay inside the repository: ${relativePath}`)
  }

  return normalized
}

function resolveInsideRoot(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  const absoluteRoot = path.resolve(root)
  const absolutePath = path.resolve(absoluteRoot, normalized)

  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Release path escapes the repository: ${relativePath}`)
  }

  return { absolutePath, normalized }
}

export async function listRegularFiles(root, relativeDirectory) {
  const { absolutePath, normalized } = resolveInsideRoot(root, relativeDirectory)
  const entries = await readdir(absolutePath, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const entryRelativePath = `${normalized}/${entry.name}`

    if (entry.isSymbolicLink()) {
      throw new Error(`Release evidence does not accept symbolic links: ${entryRelativePath}`)
    }

    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(root, entryRelativePath)))
    } else if (entry.isFile()) {
      files.push(entryRelativePath)
    }
  }

  return files
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

export async function createSha256Manifest(root, relativePaths) {
  const uniquePaths = [...new Set(relativePaths.map(normalizeRelativePath))].sort()
  const records = []

  for (const relativePath of uniquePaths) {
    const { absolutePath } = resolveInsideRoot(root, relativePath)
    const fileStat = await lstat(absolutePath)

    if (fileStat.isSymbolicLink()) {
      throw new Error(`Release evidence does not accept symbolic links: ${relativePath}`)
    }

    if (!fileStat.isFile()) {
      throw new Error(`Release artifact is not a regular file: ${relativePath}`)
    }

    records.push(`${await sha256File(absolutePath)}  ${relativePath}`)
  }

  return `${records.join("\n")}\n`
}

export function createContractSbom(projectName, projectVersion, openZeppelinVersion) {
  const rootReference = `${projectName}-contracts@${projectVersion}`
  const openZeppelinReference = `pkg:npm/%40openzeppelin/contracts@${openZeppelinVersion}`
  const forgeStdReference = `pkg:github/foundry-rs/forge-std@${FORGE_STD_COMMIT}`

  return {
    $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootReference,
        name: `${projectName}-contracts`,
        version: projectVersion,
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": openZeppelinReference,
        group: "@openzeppelin",
        name: "contracts",
        version: openZeppelinVersion,
        purl: openZeppelinReference,
        licenses: [{ license: { id: "MIT" } }],
        externalReferences: [
          {
            type: "vcs",
            url: `https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v${openZeppelinVersion}`,
          },
        ],
      },
      {
        type: "library",
        "bom-ref": forgeStdReference,
        group: "foundry-rs",
        name: "forge-std",
        version: FORGE_STD_COMMIT,
        purl: forgeStdReference,
        licenses: [{ expression: "Apache-2.0 OR MIT" }],
        externalReferences: [
          {
            type: "vcs",
            url: `https://github.com/foundry-rs/forge-std/tree/${FORGE_STD_COMMIT}`,
          },
        ],
      },
    ],
    dependencies: [
      { ref: rootReference, dependsOn: [forgeStdReference, openZeppelinReference] },
      { ref: forgeStdReference, dependsOn: [] },
      { ref: openZeppelinReference, dependsOn: [] },
    ],
  }
}

export function validateToolchainProfile({
  engines,
  nodeVersion,
  packageManager,
  runtimeNodeVersion,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion ?? "")) {
    throw new Error(".node-version must contain an exact semantic version")
  }

  const packageManagerMatch = /^npm@(\d+)\.(\d+)\.(\d+)$/.exec(packageManager ?? "")
  if (!packageManagerMatch) {
    throw new Error("packageManager must pin an exact npm semantic version")
  }

  const nodeMajor = Number(nodeVersion.split(".")[0])
  const npmMajor = Number(packageManagerMatch[1])
  const expectedNodeEngine = `${nodeMajor}.x`
  const expectedNpmEngine = `>=${npmMajor} <${npmMajor + 1}`

  if (engines?.node !== expectedNodeEngine || engines?.npm !== expectedNpmEngine) {
    throw new Error(
      `engines must declare provider-compatible ranges ${expectedNodeEngine} and ${expectedNpmEngine}`,
    )
  }

  if (runtimeNodeVersion !== `v${nodeVersion}`) {
    throw new Error(`Release evidence requires Node.js ${nodeVersion}; found ${runtimeNodeVersion}`)
  }

  return Object.freeze({
    nodeVersion,
    packageManagerVersion: packageManagerMatch.slice(1).join("."),
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      )
    })
  })
}

async function createSbom(root) {
  const outputPath = path.join(root, SBOM_FILE)
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  const binaryName = process.platform === "win32" ? "cyclonedx-npm.cmd" : "cyclonedx-npm"
  const executable = path.join(root, "node_modules", ".bin", binaryName)

  try {
    await run(
      executable,
      [
        "--package-lock-only",
        "--output-reproducible",
        "--spec-version",
        "1.6",
        "--output-format",
        "JSON",
        "--output-file",
        temporaryPath,
        "--validate",
        "--mc-type",
        "application",
        "--omit",
        "dev",
      ],
      { cwd: root },
    )
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function createContractsSbom(root, packageJson, openZeppelinVersion) {
  const contractSbom = createContractSbom(
    packageJson.name,
    packageJson.version,
    openZeppelinVersion,
  )
  const serialized = `${JSON.stringify(contractSbom, null, 2)}\n`
  const validationError = await new JsonValidator(CycloneDxVersion.v1dot6).validate(serialized)

  if (validationError !== null) {
    throw new Error(`Contract CycloneDX validation failed: ${JSON.stringify(validationError)}`)
  }

  await writeFile(path.join(root, CONTRACT_SBOM_FILE), serialized, "utf8")
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
  const openZeppelinVersion = packageJson.devDependencies?.["@openzeppelin/contracts"]
  const nodeVersion = (await readFile(path.join(PROJECT_ROOT, ".node-version"), "utf8")).trim()
  const { packageManagerVersion } = validateToolchainProfile({
    engines: packageJson.engines,
    nodeVersion,
    packageManager: packageJson.packageManager,
    runtimeNodeVersion: process.version,
  })

  if (!/^\d+\.\d+\.\d+$/.test(openZeppelinVersion ?? "")) {
    throw new Error("@openzeppelin/contracts must use an exact semantic version")
  }

  for (const relativePath of [".github/workflows/ci.yml", "README.md"]) {
    const contents = await readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
    if (!contents.includes(FORGE_STD_COMMIT)) {
      throw new Error(`${relativePath} must reference the pinned forge-std commit`)
    }
  }

  const workflow = await readFile(path.join(PROJECT_ROOT, ".github/workflows/ci.yml"), "utf8")
  if (!workflow.includes(`npm@${packageManagerVersion}`)) {
    throw new Error("CI must install the packageManager npm version")
  }

  const outputPath = path.join(PROJECT_ROOT, OUTPUT_DIRECTORY)
  await mkdir(outputPath, { recursive: true })
  await createSbom(PROJECT_ROOT)
  await createContractsSbom(PROJECT_ROOT, packageJson, openZeppelinVersion)

  const releaseRecord = {
    schemaVersion: 2,
    project: packageJson.name,
    version: packageJson.version,
    commit: process.env.RELEASE_COMMIT ?? process.env.GITHUB_SHA ?? null,
    toolchain: {
      node: process.version,
      packageManager: packageJson.packageManager,
    },
    contractDependencies: {
      openZeppelinContracts: {
        package: "@openzeppelin/contracts",
        version: openZeppelinVersion,
      },
      forgeStd: {
        repository: "https://github.com/foundry-rs/forge-std",
        commit: FORGE_STD_COMMIT,
      },
    },
    artifacts: {
      web: "dist/",
      contracts: CONTRACT_ARTIFACTS,
      securityDocuments: RELEASE_DOCUMENTS,
      releaseTooling: RELEASE_TOOLING,
      sbom: SBOM_FILE,
      contractSbom: CONTRACT_SBOM_FILE,
    },
    deploymentEvidenceRequirements: createDeploymentEvidenceRequirements(),
    notes: [
      "A null commit means the evidence was generated outside a tagged CI release.",
      "Hashes establish artifact identity; they do not establish deployment or audit status.",
      "Deployment requirements are a record schema, not proof that any address, route, quote, receipt, or canary exists.",
    ],
  }

  await writeFile(
    path.join(PROJECT_ROOT, RELEASE_FILE),
    `${JSON.stringify(releaseRecord, null, 2)}\n`,
    "utf8",
  )

  const webArtifacts = await listRegularFiles(PROJECT_ROOT, "dist")
  const manifest = await createSha256Manifest(PROJECT_ROOT, [
    ...BUILD_INPUTS,
    ...CONTRACT_ARTIFACTS,
    ...RELEASE_DOCUMENTS,
    ...RELEASE_TOOLING,
    ...webArtifacts,
    SBOM_FILE,
    CONTRACT_SBOM_FILE,
    RELEASE_FILE,
  ])
  await writeFile(path.join(PROJECT_ROOT, MANIFEST_FILE), manifest, "utf8")

  process.stdout.write(
    `Wrote ${MANIFEST_FILE}, ${RELEASE_FILE}, ${SBOM_FILE}, and ${CONTRACT_SBOM_FILE} (${webArtifacts.length} web files).\n`,
  )
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
