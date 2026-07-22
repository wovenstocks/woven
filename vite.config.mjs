import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { isIP } from "node:net"
import { resolveBnbNetworkProfile } from "./src/config/bnbNetworks.js"

const addressPattern = /^0x[a-fA-F0-9]{40}$/
const zeroAddressPattern = /^0x0{40}$/i
const robotsPolicyToken = "__WOVEN_ROBOTS_POLICY__"
const siteUrlToken = "__WOVEN_SITE_URL__"
const fallbackSiteUrl = "https://wovenstocks.com"
const indexableRobotsPolicy =
  "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
const privateRobotsPolicy = "noindex, nofollow, noarchive, nosnippet"
const requiredLaunchAddresses = Object.freeze([
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
])

function isValidAddress(value) {
  return addressPattern.test(value || "") && !zeroAddressPattern.test(value)
}

function hasPinnedCoreFourRecipe(value) {
  if (typeof value !== "string") return false
  const units = value.split(",").map((unit) => unit.trim())
  const maxUint256 = (1n << 256n) - 1n
  return (
    units.length === 4 &&
    units.every((unit) => /^[1-9]\d*$/.test(unit) && BigInt(unit) <= maxUint256)
  )
}

function readPublicSiteUrl(value) {
  if (typeof value !== "string" || !value.trim()) return ""
  try {
    const url = new URL(value.trim())
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return ""
    }
    return url.origin
  } catch {
    return ""
  }
}

function hasCustomPublicHostname(siteUrl) {
  if (!siteUrl) return false
  const hostname = new URL(siteUrl).hostname.toLowerCase()
  return (
    hostname.includes(".") &&
    hostname !== "vercel.app" &&
    !hostname.endsWith(".vercel.app") &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    isIP(hostname) === 0
  )
}

export function isPublicLaunchReady(environment, network) {
  const addresses = requiredLaunchAddresses.map((key) => environment[key])
  const normalizedAddresses = addresses.map((address) => address?.toLowerCase())
  const publicSiteUrl = readPublicSiteUrl(environment.VITE_PUBLIC_SITE_URL)

  return (
    environment.VITE_PUBLIC_LAUNCH_LIVE?.trim().toLowerCase() === "true" &&
    environment.VITE_BNB_NETWORK?.trim().toLowerCase() === "mainnet" &&
    network.key === "mainnet" &&
    addresses.every(isValidAddress) &&
    new Set(normalizedAddresses).size === normalizedAddresses.length &&
    hasPinnedCoreFourRecipe(environment.VITE_BASKET_CORE4_UNITS_RAW) &&
    hasCustomPublicHostname(publicSiteUrl)
  )
}

function launchMetadataGate(publicLaunchReady, publicSiteUrl) {
  return {
    name: "woven-launch-metadata-gate",
    transformIndexHtml(html) {
      if (!html.includes(robotsPolicyToken) || !html.includes(siteUrlToken)) {
        throw new Error("A Woven launch metadata marker is missing from index.html.")
      }
      const policy = publicLaunchReady ? indexableRobotsPolicy : privateRobotsPolicy
      return html
        .replaceAll(robotsPolicyToken, policy)
        .replaceAll(siteUrlToken, publicSiteUrl || fallbackSiteUrl)
    },
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_")
  const network = resolveBnbNetworkProfile(environment.VITE_BNB_NETWORK)
  const publicLaunchReady = isPublicLaunchReady(environment, network)
  const publicSiteUrl = readPublicSiteUrl(environment.VITE_PUBLIC_SITE_URL)

  return {
    build: {
      outDir: mode === "e2e" ? "dist-e2e" : "dist",
    },
    define: {
      "import.meta.env.VITE_BNB_NETWORK": JSON.stringify(network.key),
    },
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    test: {
      include: [
        "src/**/*.test.{js,jsx}",
        "scripts/**/*.test.js",
        "tools/**/*.test.mjs",
        "vite.config.test.js",
      ],
    },
    plugins: [launchMetadataGate(publicLaunchReady, publicSiteUrl), react()],
  }
})
