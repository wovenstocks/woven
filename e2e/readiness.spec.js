import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
}

async function expectNoSeriousAccessibilityViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()

  expect(
    results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact)),
  ).toEqual([])
}

test("landing page is responsive, original and accessible", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveTitle("Woven")
  await expect(page.getByRole("heading", { name: "Built from many. Held as one." })).toBeVisible()
  await expect(page.locator(".hero__copy")).toHaveCSS("opacity", "1")
  await expect(page.locator(".hero img")).toHaveJSProperty("complete", true)
  await expect(page.locator(".hero img")).not.toHaveJSProperty("naturalWidth", 0)
  await expect(page.getByRole("link", { name: "Woven Stocks on X" })).toHaveAttribute(
    "href",
    "https://x.com/wovenstocks",
  )
  await expect(page.getByRole("link", { name: "Woven Stocks on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/wovenstocks/woven",
  )
  const header = page.locator("header.site-header")
  await expect(
    header.locator(
      '.site-nav a[href="https://four.meme/en/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff"]',
    ),
  ).toHaveCount(1)
  await expect(header.locator('a[aria-label="Woven on X"]')).toHaveAttribute(
    "href",
    "https://x.com/wovenstocks",
  )
  await expect(header.locator('a[aria-label="Woven on GitHub"]')).toHaveAttribute(
    "href",
    "https://github.com/wovenstocks/woven",
  )
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /\/woven-social-preview\.png$/,
  )
  await expect(page.getByText("Risk & eligibility", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Licenses", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /0xE40b8931.*C1Ffff/ })).toHaveAttribute(
    "href",
    "https://bscscan.com/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff",
  )
  await expect(page.getByRole("button", { name: "Copy WOVEN contract" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expectNoSeriousAccessibilityViolations(page)
})

test("mobile navigation reaches every primary product area", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Mobile navigation check")

  await page.goto("/")
  await page.getByRole("button", { name: "Open menu" }).click()
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" })
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole("link", { name: "Buy $WOVEN" })).toHaveAttribute(
    "href",
    "https://four.meme/en/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff",
  )
  await expect(navigation.getByRole("link", { name: "Woven on X" })).toHaveAttribute(
    "href",
    "https://x.com/wovenstocks",
  )
  await expect(navigation.getByRole("link", { name: "Woven on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/wovenstocks/woven",
  )
  await navigation.getByRole("button", { name: "Explore baskets" }).click()
  await expect(page).toHaveURL(/#app$/)
  await expect(page).toHaveTitle("Woven")
  await expect(page.getByRole("heading", { name: "Explore baskets" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("basket detail keeps buy, mint and redeem distinct", async ({ page }) => {
  await page.goto("/#app")
  await expect(
    page.locator(
      '.app-nav a[href="https://four.meme/en/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff"]',
    ),
  ).toHaveCount(1)
  await page.getByRole("button", { name: "View Woven Core Four basket" }).click()

  await expect(page.getByRole("heading", { name: "Woven Core Four", level: 1 })).toBeVisible()
  await expect(page.getByRole("button", { name: "Buy", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await page.getByRole("button", { name: "Mint", exact: true }).click()
  await expect(page.getByText("Gross basket amount", { exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Redeem", exact: true }).click()
  await expect(page.getByText("Basket tokens to redeem", { exact: true })).toBeVisible()
  await expect(page.getByText("Redemption fee")).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("creator review follows the unit inputs and never skips confirmation", async ({ page }) => {
  await page.goto("/#studio")

  const unitInput = page.getByRole("spinbutton", { name: "META units per basket token" })
  const publishButton = page.getByRole("button", { name: "Review basket" })
  await expect(unitInput).toBeVisible()
  await expect(publishButton).toBeVisible()
  const publishHandle = await publishButton.elementHandle()
  expect(
    await unitInput.evaluate(
      (input, button) =>
        Boolean(input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
      publishHandle,
    ),
  ).toBe(true)

  await publishButton.click()
  const dialog = page.getByRole("dialog", { name: "Publish this basket?" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Woven Tech Basket · $WTECH")).toBeVisible()
  await expect(dialog.getByText("1 per token")).toHaveCount(3)
  await dialog.getByRole("button", { name: "Go back" }).click()
  await expect(dialog).toBeHidden()
  await expectNoHorizontalOverflow(page)
})

test("desktop Studio fits one normal viewport and short screens remain scrollable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop viewport check")

  await page.goto("/#studio")
  await expect(page.getByRole("heading", { name: "Create a bStock basket." })).toBeVisible()
  const normal = await page.evaluate(() => ({
    viewport: window.innerHeight,
    content: document.documentElement.scrollHeight,
  }))
  expect(normal.content).toBeLessThanOrEqual(normal.viewport + 1)

  await page.setViewportSize({ width: 1024, height: 500 })
  const short = await page.evaluate(() => ({
    viewport: window.innerHeight,
    content: document.documentElement.scrollHeight,
  }))
  expect(short.content).toBeGreaterThan(short.viewport)
  await page
    .getByRole("spinbutton", { name: "NVDA units per basket token" })
    .scrollIntoViewIfNeeded()
  await expect(page.getByRole("spinbutton", { name: "NVDA units per basket token" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("missing wallet fails safely without opening a transaction", async ({ page }) => {
  await page.goto("/#app")
  await page.getByRole("button", { name: "Connect wallet" }).click()

  const dialog = page.getByRole("dialog", { name: "Wallet request failed" })
  await expect(dialog).toContainText("No browser wallet was found")
  await expect(page.getByText(/transaction (pending|submitted)/i)).toHaveCount(0)
})
