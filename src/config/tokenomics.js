export const WOVEN_TOKENOMICS = Object.freeze({
  targetSupply: 1_000_000_000,
  creatorLicense: 10_000,
  mintFeeBps: 30,
  maxMintFeeBps: 50,
  creatorFeeShare: 60,
  treasuryFeeShare: 40,
  redemptionFeeBps: 0,
  basketSupplyCap: 1_000,
})

export const WOVEN_LICENSE_SINK = "0x000000000000000000000000000000000000dEaD"

export function formatWoven(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}
