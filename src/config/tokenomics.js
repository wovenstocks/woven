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

export const WOVEN_TOKEN_ADDRESS = "0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff"
export const WOVEN_FOUR_MEME_URL =
  "https://four.meme/en/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff"
export const WOVEN_EXPLORER_URL =
  "https://bscscan.com/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff"
export const WOVEN_LICENSE_SINK = "0x000000000000000000000000000000000000dEaD"

export function formatWoven(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}
