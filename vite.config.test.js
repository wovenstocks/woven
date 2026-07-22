import { describe, expect, it } from "vitest"
import { isPublicLaunchReady } from "./vite.config.mjs"

const requiredAddressKeys = [
  "VITE_WOVEN_TOKEN",
  "VITE_CREATOR_LICENSE",
  "VITE_ASSET_REGISTRY",
  "VITE_FEE_SPLITTER",
  "VITE_CURATOR_GUARDIAN",
  "VITE_BASKET_FACTORY",
  "VITE_USDC",
  "VITE_ONE_CLICK_ROUTER",
  "VITE_BSTOCK_NVDAB",
  "VITE_BSTOCK_MSFTB",
  "VITE_BSTOCK_TSLAB",
  "VITE_BSTOCK_QQQB",
  "VITE_BASKET_CORE4",
]

function completeLaunchEnvironment() {
  const environment = {
    VITE_PUBLIC_LAUNCH_LIVE: "true",
    VITE_PUBLIC_SITE_URL: "https://wovenstocks.com",
    VITE_BNB_NETWORK: "mainnet",
    VITE_BASKET_CORE4_UNITS_RAW: "1,2,3,4",
  }

  requiredAddressKeys.forEach((key, index) => {
    environment[key] = `0x${(index + 1).toString(16).padStart(40, "0")}`
  })
  return environment
}

describe("public launch indexing gate", () => {
  it("accepts only an explicitly complete custom-domain mainnet profile", () => {
    const environment = completeLaunchEnvironment()

    expect(isPublicLaunchReady(environment, { key: "mainnet" })).toBe(true)
  })

  it("fails closed for incomplete or unsafe release metadata", () => {
    const environment = completeLaunchEnvironment()
    const invalidProfiles = [
      { ...environment, VITE_PUBLIC_LAUNCH_LIVE: "false" },
      { ...environment, VITE_PUBLIC_SITE_URL: "https://woven-preview.vercel.app" },
      { ...environment, VITE_PUBLIC_SITE_URL: "https://vercel.app" },
      { ...environment, VITE_PUBLIC_SITE_URL: "https://localhost" },
      { ...environment, VITE_PUBLIC_SITE_URL: "https://127.0.0.1" },
      { ...environment, VITE_BNB_NETWORK: "testnet" },
      { ...environment, VITE_USDC: "" },
      { ...environment, VITE_BASKET_CORE4_UNITS_RAW: "1,2,3" },
      {
        ...environment,
        VITE_BASKET_CORE4_UNITS_RAW: `${1n << 256n},2,3,4`,
      },
      { ...environment, VITE_ONE_CLICK_ROUTER: environment.VITE_USDC },
    ]

    for (const profile of invalidProfiles) {
      expect(isPublicLaunchReady(profile, { key: profile.VITE_BNB_NETWORK })).toBe(false)
    }
  })
})
