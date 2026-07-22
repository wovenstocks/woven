import { once } from "node:events"
import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { createReleaseConsoleServer } from "./server.mjs"

let server

afterEach(async () => {
  if (!server?.listening) return
  server.close()
  await once(server, "close")
})

async function startServer() {
  server = createReleaseConsoleServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

function rawRequest({ port, host, path = "/", method = "GET" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { Host: host } },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () => resolve({ response, body }))
      },
    )
    request.on("error", reject)
    request.end()
  })
}

describe("localhost release-console server", () => {
  it("serves only allowlisted assets with strict security headers", async () => {
    const port = await startServer()
    const { response, body } = await rawRequest({ port, host: `127.0.0.1:${port}` })
    expect(response.statusCode).toBe(200)
    expect(body).toContain("Woven Release Console")
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0")
    expect(response.headers["content-security-policy"]).toContain("connect-src 'none'")
    expect(response.headers["x-frame-options"]).toBe("DENY")

    const missing = await rawRequest({
      port,
      host: `localhost:${port}`,
      path: "/package.json",
    })
    expect(missing.response.statusCode).toBe(404)
  })

  it("rejects forged Host headers and state-changing HTTP methods", async () => {
    const port = await startServer()
    const forbidden = await rawRequest({ port, host: "attacker.example" })
    expect(forbidden.response.statusCode).toBe(403)

    const post = await rawRequest({ port, host: `127.0.0.1:${port}`, method: "POST" })
    expect(post.response.statusCode).toBe(405)
    expect(post.response.headers.allow).toBe("GET, HEAD")
  })
})
