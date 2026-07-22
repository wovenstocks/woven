import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CONTRACT_ARTIFACTS,
  RELEASE_DOCUMENTS,
  RELEASE_TOOLING,
  createContractSbom,
  createDeploymentEvidenceRequirements,
  createSha256Manifest,
  listRegularFiles,
  validateToolchainProfile,
} from "./create-release-evidence.mjs"

const temporaryDirectories = []

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "woven-release-evidence-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("release evidence", () => {
  it("separates exact release pins from provider-compatible engine ranges", () => {
    expect(
      validateToolchainProfile({
        engines: { node: "24.x", npm: ">=11 <12" },
        nodeVersion: "24.14.0",
        packageManager: "npm@11.16.0",
        runtimeNodeVersion: "v24.14.0",
      }),
    ).toEqual({ nodeVersion: "24.14.0", packageManagerVersion: "11.16.0" })

    expect(() =>
      validateToolchainProfile({
        engines: { node: "24.14.0", npm: "11.16.0" },
        nodeVersion: "24.14.0",
        packageManager: "npm@11.16.0",
        runtimeNodeVersion: "v24.14.0",
      }),
    ).toThrow(/provider-compatible ranges/)

    expect(() =>
      validateToolchainProfile({
        engines: { node: "24.x", npm: ">=11 <12" },
        nodeVersion: "24.14.0",
        packageManager: "npm@11.16.0",
        runtimeNodeVersion: "v24.15.0",
      }),
    ).toThrow(/requires Node\.js 24\.14\.0/)
  })

  it("records both pinned contract dependencies in CycloneDX format", () => {
    const sbom = createContractSbom("woven-protocol", "0.1.0", "5.6.1")

    expect(sbom.specVersion).toBe("1.6")
    expect(sbom.components.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "contracts", version: "5.6.1" },
      { name: "forge-std", version: "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b" },
    ])
    expect(sbom.dependencies[0].dependsOn).toHaveLength(2)
  })

  it("includes every production router, adapter, and deployment artifact", () => {
    expect(CONTRACT_ARTIFACTS).toEqual(
      expect.arrayContaining([
        "contracts/out/OneClickBasketRouter.sol/OneClickBasketRouter.json",
        "contracts/out/PancakeV2ExactOutputAdapter.sol/PancakeV2ExactOutputAdapter.json",
        "contracts/out/PancakeV3ExactOutputAdapter.sol/PancakeV3ExactOutputAdapter.json",
        "contracts/out/UniswapV4ExactOutputAdapter.sol/UniswapV4ExactOutputAdapter.json",
        "contracts/out/DeployBuyRouter.s.sol/DeployBuyRouter.json",
        "contracts/out/DeployCoreFour.s.sol/DeployCoreFour.json",
      ]),
    )
    expect(new Set(CONTRACT_ARTIFACTS).size).toBe(CONTRACT_ARTIFACTS.length)
    expect(RELEASE_DOCUMENTS).toContain("docs/DEPLOYMENT_RECORD_TEMPLATE.md")
    expect(RELEASE_DOCUMENTS).toContain("docs/LAUNCH_OPERATOR_RUNBOOK.md")
    expect(RELEASE_DOCUMENTS).toContain("contracts/security-artifacts/SECURITY_WORKFLOW_REPORT.md")
    expect(RELEASE_TOOLING).toContain("tools/release-console/server.mjs")
    expect(RELEASE_TOOLING).toContain("tools/release-console/core.mjs")
  })

  it("records CORE4 routes, code-hash pins, and exact-output probe requirements", () => {
    const requirements = createDeploymentEvidenceRequirements()

    expect(requirements.deploymentScripts).toEqual({
      core: "contracts/script/DeployCore.s.sol:DeployCore",
      buyRouter: "contracts/script/DeployBuyRouter.s.sol:DeployBuyRouter",
      coreFour: "contracts/script/DeployCoreFour.s.sol:DeployCoreFour",
    })
    expect(requirements.coreFour).toMatchObject({
      name: "Woven Core Four",
      symbol: "CORE4",
      assetOrder: ["NVDAB", "MSFTB", "TSLAB", "QQQB"],
      displayedUnitPerAsset: "10000000000000000",
      mintFeeBps: 30,
      webAddressEnvironment: "VITE_BASKET_CORE4",
      webRawUnitsEnvironment: "VITE_BASKET_CORE4_UNITS_RAW",
    })
    expect(requirements.routes.map(({ asset }) => asset)).toEqual([
      "NVDAB",
      "MSFTB",
      "TSLAB",
      "QQQB",
    ])
    expect(requirements.routes.map(({ routeIdPreimage }) => routeIdPreimage)).toEqual([
      "WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1",
      "WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1",
      "WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1",
      "WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1",
    ])
    expect(requirements.codehashPinEnvironment).toEqual(
      expect.arrayContaining([
        "EXPECTED_ONE_CLICK_ROUTER_CODEHASH",
        "EXPECTED_UNISWAP_V4_ADAPTER_CODEHASH",
        "EXPECTED_PANCAKE_V3_ADAPTER_CODEHASH",
        "EXPECTED_USDC_IMPLEMENTATION_CODEHASH",
        "EXPECTED_BSTOCK_BEACON_CODEHASH",
        "EXPECTED_BSTOCK_IMPLEMENTATION_CODEHASH",
        "EXPECTED_UNISWAP_UNIVERSAL_ROUTER_CODEHASH",
        "EXPECTED_UNISWAP_PERMIT2_CODEHASH",
      ]),
    )
    expect(requirements.quoteProbeEnvironment).toHaveLength(8)
    expect(requirements.quoteProbeEnvironment).toContain("PROBE_RAW_OUTPUT_NVDAB")
    expect(requirements.quoteProbeEnvironment).toContain("MAX_PROBE_USDC_IN_QQQB")
    expect(requirements.compiledButExcludedFromInitialRouteSet[0].contract).toBe(
      "PancakeV2ExactOutputAdapter",
    )
  })

  it("discovers regular files in stable path order", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "dist", "assets"), { recursive: true })
    await writeFile(path.join(root, "dist", "z.txt"), "z\n")
    await writeFile(path.join(root, "dist", "assets", "a.txt"), "a\n")

    await expect(listRegularFiles(root, "dist")).resolves.toEqual([
      "dist/assets/a.txt",
      "dist/z.txt",
    ])
  })

  it("produces a sorted, reproducible SHA-256 manifest", async () => {
    const root = await fixture()
    await writeFile(path.join(root, "b.txt"), "beta\n")
    await writeFile(path.join(root, "a.txt"), "alpha\n")

    const first = await createSha256Manifest(root, ["b.txt", "a.txt", "a.txt"])
    const second = await createSha256Manifest(root, ["a.txt", "b.txt"])

    expect(first).toBe(second)
    expect(
      first
        .split("\n")
        .filter(Boolean)
        .map((record) => record.slice(66)),
    ).toEqual(["a.txt", "b.txt"])
  })

  it("rejects traversal and symbolic links", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "dist"))
    await symlink(tmpdir(), path.join(root, "dist", "outside"))

    await expect(createSha256Manifest(root, ["../outside"])).rejects.toThrow(
      "must stay inside the repository",
    )
    await expect(createSha256Manifest(root, ["dist/outside"])).rejects.toThrow(
      "does not accept symbolic links",
    )
    await expect(listRegularFiles(root, "dist")).rejects.toThrow("does not accept symbolic links")
  })
})
