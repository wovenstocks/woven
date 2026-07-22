import { createPublicClient, http } from "viem"
import { bsc, bscTestnet } from "viem/chains"
import { resolveBnbNetworkProfile } from "../src/config/bnbNetworks.js"
import {
  assertPinnedBytecode,
  buildSafeDeployment,
  parseArgs,
  requiredAddress,
  safeProfile,
  safeProxyFactoryAbi,
} from "./safe-profile.mjs"

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const owner = requiredAddress(args.owner, "Owner")
  const network = resolveBnbNetworkProfile(args.network)
  const saltNonce = BigInt(args["salt-nonce"] || "0")
  const rpcUrl = process.env.WOVEN_BNB_RPC_URL || network.rpcUrl
  const chain = network.key === "mainnet" ? bsc : bscTestnet
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 12_000 }) })

  const actualChainId = await client.getChainId()
  if (actualChainId !== network.chainId) {
    throw new Error(`RPC returned chain ${actualChainId}; expected ${network.chainId}.`)
  }

  const requiredContracts = [
    ["Safe singleton", safeProfile.singleton, safeProfile.singletonRuntimeCodehash],
    ["Safe proxy factory", safeProfile.proxyFactory, safeProfile.proxyFactoryRuntimeCodehash],
    [
      "Safe fallback handler",
      safeProfile.fallbackHandler,
      safeProfile.fallbackHandlerRuntimeCodehash,
    ],
  ]
  for (const [label, address, expectedCodehash] of requiredContracts) {
    const code = await client.getBytecode({ address })
    assertPinnedBytecode(code, expectedCodehash, label)
  }

  const proxyCreationCode = await client.readContract({
    address: safeProfile.proxyFactory,
    abi: safeProxyFactoryAbi,
    functionName: "proxyCreationCode",
  })
  assertPinnedBytecode(
    proxyCreationCode,
    safeProfile.proxyCreationCodehash,
    "Safe proxy creation code",
  )
  const deployment = buildSafeDeployment({ owner, saltNonce, proxyCreationCode })
  const existingCode = await client.getBytecode({ address: deployment.predictedSafe })
  const alreadyDeployed = Boolean(existingCode && existingCode !== "0x")
  if (alreadyDeployed) {
    assertPinnedBytecode(existingCode, safeProfile.proxyRuntimeCodehash, "Predicted Safe proxy")
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "woven-safe-deployment/v1",
        network: network.key,
        chainId: network.chainId,
        owner,
        threshold: 1,
        saltNonce: saltNonce.toString(),
        predictedSafe: deployment.predictedSafe,
        alreadyDeployed,
        profile: {
          version: safeProfile.version,
          singleton: safeProfile.singleton,
          proxyFactory: safeProfile.proxyFactory,
          proxyFactoryRuntimeCodehash: safeProfile.proxyFactoryRuntimeCodehash,
          proxyCreationCodehash: safeProfile.proxyCreationCodehash,
          proxyRuntimeCodehash: safeProfile.proxyRuntimeCodehash,
          fallbackHandler: safeProfile.fallbackHandler,
          modules: [],
          guard: null,
        },
        unsignedTransaction: {
          from: owner,
          to: safeProfile.proxyFactory,
          value: "0",
          data: deployment.transactionData,
        },
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Safe preparation failed: ${message}\n`)
  process.exitCode = 1
})
