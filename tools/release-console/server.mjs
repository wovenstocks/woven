import { createReadStream } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url))
const LISTEN_HOST = "127.0.0.1"
const DEFAULT_PORT = 47831
const ASSETS = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
  "/core.mjs": ["core.mjs", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
})

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
})

function parsePort(value) {
  if (value === undefined) return DEFAULT_PORT
  if (!/^[0-9]{1,5}$/.test(value)) throw new Error("Port must be an integer from 1024 to 65535.")
  const port = Number(value)
  if (port < 1024 || port > 65_535) throw new Error("Port must be between 1024 and 65535.")
  return port
}

function parseArguments(arguments_) {
  let port
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--port") {
      if (port !== undefined) throw new Error("--port may be specified only once.")
      port = arguments_[index + 1]
      if (!port) throw new Error("--port requires a value.")
      index += 1
      continue
    }
    if (argument === "--host" || argument.startsWith("--host=")) {
      throw new Error("The release console cannot bind to a configurable or remote host.")
    }
    throw new Error(`Unexpected argument: ${argument}`)
  }
  return parsePort(port)
}

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value)
  }
}

function isAllowedHostHeader(hostHeader, port) {
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`
}

export function createReleaseConsoleServer({ expectedPort } = {}) {
  if (
    expectedPort !== undefined &&
    (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65_535)
  ) {
    throw new Error("A valid expected port is required.")
  }

  const server = createServer((request, response) => {
    setSecurityHeaders(response)
    const activePort = expectedPort ?? server.address()?.port
    if (!activePort || !isAllowedHostHeader(request.headers.host, activePort)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Forbidden host.\n")
      return
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD")
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Method not allowed.\n")
      return
    }

    let pathname
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Invalid request URL.\n")
      return
    }
    const asset = ASSETS[pathname]
    if (!asset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Not found.\n")
      return
    }

    const [filename, contentType] = asset
    response.writeHead(200, { "Content-Type": contentType })
    if (request.method === "HEAD") {
      response.end()
      return
    }
    const stream = createReadStream(path.join(TOOL_ROOT, filename))
    stream.on("error", () => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
    stream.pipe(response)
  })
  return server
}

async function main() {
  const port = parseArguments(process.argv.slice(2))
  const server = createReleaseConsoleServer({ expectedPort: port })

  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Release console failed: ${message}\n`)
    process.exitCode = 1
  })
  server.listen(port, LISTEN_HOST, () => {
    process.stdout.write(`Woven release console: http://${LISTEN_HOST}:${port}\n`)
    process.stdout.write("Localhost only. Closing this process immediately disables the console.\n")
  })
}

const isCommandLine = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (isCommandLine) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Release console failed: ${message}\n`)
    process.exitCode = 1
  })
}

export const releaseConsoleSecurityHeaders = SECURITY_HEADERS
