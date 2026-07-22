import { wovenContracts } from "../config/contracts"
import { bnbChain } from "./chain"
import { ProtocolError, runProtocolAction } from "./errors"
import { BNB_CONFIGURED_CHAIN_ID, normalizeAddress } from "./validation"

let viemPromise

const loadViem = () => {
  viemPromise ||= import("./viem-runtime")
  return viemPromise
}

function requireProvider(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw new ProtocolError("WALLET_UNAVAILABLE", "No compatible browser wallet is available.")
  }
  return provider
}

export async function createBnbPublicClient(options = {}) {
  return runProtocolAction("connect to BNB Chain", async () => {
    if (options.rpcUrl && !wovenContracts.rpcUrls.includes(options.rpcUrl)) {
      throw new ProtocolError(
        "INVALID_RPC_URL",
        `The RPC endpoint does not match the ${wovenContracts.networkName} build profile.`,
      )
    }

    const { createPublicClient, fallback, http } = await loadViem()
    const rpcUrls = options.rpcUrl ? [options.rpcUrl] : wovenContracts.rpcUrls
    const transports = rpcUrls.map((rpcUrl) =>
      http(rpcUrl, {
        batch: true,
        retryCount: options.retryCount ?? 2,
        retryDelay: options.retryDelay ?? 250,
        timeout: options.timeout ?? 12_000,
      }),
    )
    return createPublicClient({
      chain: bnbChain,
      transport: transports.length === 1 ? transports[0] : fallback(transports, { rank: true }),
      batch: { multicall: true },
    })
  })
}

export async function createInjectedWalletClient(options = {}) {
  return runProtocolAction("prepare wallet", async () => {
    const provider = requireProvider(options.provider)
    const account = normalizeAddress(options.account, "Wallet account")
    const { createWalletClient, custom } = await loadViem()

    const walletClient = createWalletClient({
      account,
      chain: bnbChain,
      transport: custom(provider, { retryCount: 0 }),
    })
    const chainId = await walletClient.getChainId()
    if (chainId !== BNB_CONFIGURED_CHAIN_ID) {
      throw new ProtocolError(
        "CHAIN_MISMATCH",
        `Switch your wallet to ${wovenContracts.networkName} before continuing.`,
        { details: { expectedChainId: BNB_CONFIGURED_CHAIN_ID, actualChainId: chainId } },
      )
    }

    return walletClient
  })
}

export async function createBnbClients(options = {}) {
  const publicClient = options.publicClient || (await createBnbPublicClient(options))
  const walletClient =
    options.walletClient ||
    (await createInjectedWalletClient({ provider: options.provider, account: options.account }))

  return { publicClient, walletClient }
}
