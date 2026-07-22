import { ProtocolError } from "./errors"
import { normalizeAddress } from "./validation"

export function requirePublicClient(publicClient) {
  if (!publicClient || typeof publicClient.readContract !== "function") {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain reads are unavailable.")
  }
  return publicClient
}

export async function readContract(publicClient, parameters) {
  requirePublicClient(publicClient)
  return publicClient.readContract({
    ...parameters,
    address: normalizeAddress(parameters.address, "Contract address"),
  })
}

export async function mapWithConcurrency(values, limit, mapper) {
  if (!Array.isArray(values)) return []
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, values.length || 1))
  const output = new Array(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      output[index] = await mapper(values[index], index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return output
}
