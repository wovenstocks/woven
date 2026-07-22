import { describe, expect, it, vi } from "vitest"
import { wovenContracts } from "../config/contracts"
import { executeContractWrite, waitForSuccessfulReceipt } from "./transactions"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const CONTRACT = "0x2222222222222222222222222222222222222222"
const HASH = `0x${"ab".repeat(32)}`
const REPLACEMENT_HASH = `0x${"cd".repeat(32)}`
const SECOND_REPLACEMENT_HASH = `0x${"ef".repeat(32)}`

function clients(overrides = {}) {
  const calls = []
  const publicClient = {
    simulateContract: vi.fn(async (request) => {
      calls.push("simulate")
      return { request }
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      calls.push("receipt")
      return { status: "success", blockNumber: 10n, transactionHash: HASH, logs: [] }
    }),
    ...overrides.publicClient,
  }
  const walletClient = {
    account: { address: ACCOUNT },
    getAddresses: vi.fn(async () => [ACCOUNT]),
    getChainId: vi.fn(async () => wovenContracts.chainId),
    writeContract: vi.fn(async () => {
      calls.push("write")
      return HASH
    }),
    ...overrides.walletClient,
  }
  return { publicClient, walletClient, calls }
}

describe("transaction sequencing", () => {
  it("simulates before writing and waits for a successful receipt", async () => {
    const harness = clients()
    const lifecycle = []
    const result = await executeContractWrite({
      ...harness,
      account: ACCOUNT,
      address: CONTRACT,
      abi: [],
      functionName: "approve",
      args: [CONTRACT, 1n],
      onTransactionLifecycle: (event) => lifecycle.push(event),
    })

    expect(harness.calls).toEqual(["simulate", "write", "receipt"])
    expect(harness.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH, confirmations: 2, checkReplacement: true }),
    )
    expect(result.hash).toBe(HASH)
    expect(result.receipt.status).toBe("success")
    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "confirmed"])
    expect(lifecycle[0]).toMatchObject({
      final: false,
      txHash: HASH,
      submittedHash: HASH,
      action: "approve",
    })
    expect(lifecycle[1]).toMatchObject({
      final: true,
      txHash: HASH,
      submittedHash: HASH,
      action: "approve",
    })
  })

  it.each([
    [
      "throws",
      () => {
        throw new Error("storage is read-only")
      },
    ],
    ["rejects", async () => Promise.reject(new Error("storage quota exceeded"))],
  ])("never opens the wallet when durable transaction tracking %s", async (_case, check) => {
    const harness = clients()

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "approve",
        beforeTransactionSubmit: check,
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_SAFETY_UNAVAILABLE",
      txHash: null,
      retryable: false,
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    expect(harness.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it("notifies a submitted hash before starting a receipt wait that never resolves", async () => {
    const calls = []
    let releaseSubmitted
    const submittedGate = new Promise((resolve) => {
      releaseSubmitted = resolve
    })
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(() => {
          calls.push("receipt")
          return new Promise(() => {})
        }),
      },
    })

    executeContractWrite({
      ...harness,
      account: ACCOUNT,
      address: CONTRACT,
      abi: [],
      functionName: "mint",
      onTransactionLifecycle: (event) => {
        calls.push(`lifecycle:${event.status}`)
        return event.status === "submitted" ? submittedGate : undefined
      },
    }).catch(() => {})

    await vi.waitFor(() => expect(calls).toContain("lifecycle:submitted"))
    expect(harness.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()

    releaseSubmitted()
    await vi.waitFor(() =>
      expect(harness.publicClient.waitForTransactionReceipt).toHaveBeenCalled(),
    )
    expect(calls).toEqual(["lifecycle:submitted", "receipt"])
  })

  it("fails closed with do-not-retry metadata when submitted tracking fails", async () => {
    const harness = clients()

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        onTransactionLifecycle: () => {
          throw new Error("storage unavailable")
        },
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: HASH,
      retryable: false,
      details: {
        doNotRetry: true,
        lifecycleCallbackFailed: true,
        lifecycleStatus: "submitted",
        submittedHash: HASH,
      },
    })

    expect(harness.walletClient.writeContract).toHaveBeenCalledOnce()
    expect(harness.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it("fails before simulation on the wrong chain or changed account", async () => {
    const wrongChain = clients({ walletClient: { getChainId: vi.fn(async () => 1) } })
    await expect(
      executeContractWrite({
        ...wrongChain,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "approve",
      }),
    ).rejects.toMatchObject({ code: "CHAIN_MISMATCH" })
    expect(wrongChain.publicClient.simulateContract).not.toHaveBeenCalled()

    const changed = clients({
      walletClient: {
        account: { address: "0x3333333333333333333333333333333333333333" },
      },
    })
    await expect(
      executeContractWrite({
        ...changed,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "approve",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
    expect(changed.publicClient.simulateContract).not.toHaveBeenCalled()
  })

  it("never writes when simulation fails", async () => {
    const harness = clients({
      publicClient: {
        simulateContract: vi.fn(async () => {
          throw { data: { errorName: "SupplyCapExceeded" } }
        }),
      },
    })
    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_SupplyCapExceeded" })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("fails before simulation when the current wallet context cannot be confirmed", async () => {
    const harness = clients()
    const assertCurrentContext = vi.fn(async () => {
      throw new Error("route changed")
    })

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        assertCurrentContext,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" })

    expect(assertCurrentContext).toHaveBeenCalledWith({
      phase: "before-simulate",
      account: ACCOUNT,
    })
    expect(harness.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("rechecks context after simulation and never writes when it changed", async () => {
    const harness = clients()
    const assertCurrentContext = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        assertCurrentContext,
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_CHANGED",
      details: { phase: "before-write" },
    })

    expect(assertCurrentContext).toHaveBeenCalledTimes(2)
    expect(harness.publicClient.simulateContract).toHaveBeenCalledOnce()
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("aborts when the provider account changes between simulation and write", async () => {
    const changed = "0x3333333333333333333333333333333333333333"
    const getAddresses = vi.fn().mockResolvedValueOnce([ACCOUNT]).mockResolvedValueOnce([changed])
    const harness = clients({ walletClient: { getAddresses } })

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
    expect(harness.publicClient.simulateContract).toHaveBeenCalledOnce()
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("exposes the hash when confirmation cannot be established", async () => {
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async () => {
          throw new Error("network timed out")
        }),
      },
    })
    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: HASH,
      retryable: false,
      details: { doNotRetry: true, submittedHash: HASH, currentHash: HASH },
    })
  })

  it("preserves and reports a repriced hash when receipt waiting later times out", async () => {
    const call = { to: CONTRACT, input: "0x1234", value: 0n }
    const lifecycle = []
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          onReplaced({
            reason: "repriced",
            replacedTransaction: call,
            transaction: { ...call, hash: REPLACEMENT_HASH },
          })
          const error = new Error("network timed out")
          error.name = "TimeoutError"
          throw error
        }),
      },
    })

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: REPLACEMENT_HASH,
      retryable: false,
      details: {
        doNotRetry: true,
        submittedHash: HASH,
        currentHash: REPLACEMENT_HASH,
      },
    })

    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "replaced", "unconfirmed"])
    expect(lifecycle[1]).toMatchObject({
      txHash: REPLACEMENT_HASH,
      previousHash: HASH,
      submittedHash: HASH,
      reason: "repriced",
      sameCall: true,
    })
    expect(lifecycle[2]).toMatchObject({
      txHash: REPLACEMENT_HASH,
      submittedHash: HASH,
    })
  })

  it("serializes lifecycle callbacks across multiple sequential repricings", async () => {
    const firstCall = { to: CONTRACT, input: "0x1234", value: 0n }
    const secondCall = { to: CONTRACT, input: "0x1234", value: 0n }
    const lifecycle = []
    let releaseFirstReplacement
    const firstReplacementGate = new Promise((resolve) => {
      releaseFirstReplacement = resolve
    })
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          onReplaced({
            reason: "repriced",
            replacedTransaction: firstCall,
            transaction: { ...firstCall, hash: REPLACEMENT_HASH },
          })
          onReplaced({
            reason: "repriced",
            replacedTransaction: secondCall,
            transaction: { ...secondCall, hash: SECOND_REPLACEMENT_HASH },
          })
          return {
            status: "success",
            blockNumber: 12n,
            transactionHash: SECOND_REPLACEMENT_HASH,
            logs: [],
          }
        }),
      },
    })

    const execution = executeContractWrite({
      ...harness,
      account: ACCOUNT,
      address: CONTRACT,
      abi: [],
      functionName: "mint",
      onTransactionLifecycle: (event) => {
        lifecycle.push(event)
        if (event.status === "replaced" && event.txHash === REPLACEMENT_HASH) {
          return firstReplacementGate
        }
        return undefined
      },
    })

    await vi.waitFor(() => expect(lifecycle).toHaveLength(2))
    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "replaced"])
    expect(lifecycle[1].txHash).toBe(REPLACEMENT_HASH)

    releaseFirstReplacement()
    const result = await execution
    expect(result.hash).toBe(SECOND_REPLACEMENT_HASH)
    expect(lifecycle.map((event) => event.status)).toEqual([
      "submitted",
      "replaced",
      "replaced",
      "confirmed",
    ])
    expect(lifecycle[2]).toMatchObject({
      previousHash: REPLACEMENT_HASH,
      txHash: SECOND_REPLACEMENT_HASH,
      submittedHash: HASH,
    })
  })

  it("rejects a wallet cancellation replacement instead of reporting the action as confirmed", async () => {
    const replacedTransaction = { to: CONTRACT, input: "0x1234", value: 0n }
    const replacementTransaction = {
      hash: REPLACEMENT_HASH,
      to: ACCOUNT,
      input: "0x",
      value: 0n,
    }
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          const receipt = {
            status: "success",
            blockNumber: 11n,
            transactionHash: REPLACEMENT_HASH,
            logs: [],
          }
          onReplaced({
            reason: "cancelled",
            replacedTransaction,
            transaction: replacementTransaction,
            transactionReceipt: receipt,
          })
          return receipt
        }),
      },
    })
    const lifecycle = []

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_CANCELLED",
      txHash: REPLACEMENT_HASH,
      details: { submittedHash: HASH, replacementHash: REPLACEMENT_HASH },
    })
    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "replaced", "cancelled"])
    expect(lifecycle.at(-1)).toMatchObject({
      final: true,
      txHash: REPLACEMENT_HASH,
      submittedHash: HASH,
    })
  })

  it("never clears lifecycle tracking for a cancellation with a malformed receipt", async () => {
    const replacedTransaction = { to: CONTRACT, input: "0x1234", value: 0n }
    const replacementTransaction = {
      hash: REPLACEMENT_HASH,
      to: ACCOUNT,
      input: "0x",
      value: 0n,
    }
    const lifecycle = []
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          const receipt = {
            status: "success",
            transactionHash: REPLACEMENT_HASH,
            logs: [],
          }
          onReplaced({
            reason: "cancelled",
            replacedTransaction,
            transaction: replacementTransaction,
            transactionReceipt: receipt,
          })
          return receipt
        }),
      },
    })

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: REPLACEMENT_HASH,
      retryable: false,
    })
    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "replaced", "unconfirmed"])
    expect(lifecycle.at(-1)).toMatchObject({ final: false, txHash: REPLACEMENT_HASH })
  })

  it("rejects a semantic replacement with different call data", async () => {
    const lifecycle = []
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          const receipt = {
            status: "success",
            blockNumber: 11n,
            transactionHash: REPLACEMENT_HASH,
            logs: [],
          }
          onReplaced({
            reason: "replaced",
            replacedTransaction: { to: CONTRACT, input: "0x1234", value: 0n },
            transaction: {
              hash: REPLACEMENT_HASH,
              to: CONTRACT,
              input: "0x5678",
              value: 0n,
            },
            transactionReceipt: receipt,
          })
          return receipt
        }),
      },
    })

    await expect(
      executeContractWrite({
        ...harness,
        account: ACCOUNT,
        address: CONTRACT,
        abi: [],
        functionName: "mint",
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_REPLACED",
      txHash: REPLACEMENT_HASH,
    })
    expect(lifecycle.map((event) => event.status)).toEqual([
      "submitted",
      "replaced",
      "replaced-different",
    ])
    expect(lifecycle.at(-1)).toMatchObject({
      final: true,
      txHash: REPLACEMENT_HASH,
      submittedHash: HASH,
    })
  })

  it("accepts a repriced identical call and returns the canonical replacement hash", async () => {
    const call = { to: CONTRACT, input: "0x1234", value: 0n }
    const lifecycle = []
    const harness = clients({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          const receipt = {
            status: "success",
            blockNumber: 11n,
            transactionHash: REPLACEMENT_HASH,
            logs: [],
          }
          onReplaced({
            reason: "repriced",
            replacedTransaction: call,
            transaction: { ...call, hash: REPLACEMENT_HASH },
            transactionReceipt: receipt,
          })
          return receipt
        }),
      },
    })

    const result = await executeContractWrite({
      ...harness,
      account: ACCOUNT,
      address: CONTRACT,
      abi: [],
      functionName: "mint",
      onTransactionLifecycle: (event) => lifecycle.push(event),
    })

    expect(result.hash).toBe(REPLACEMENT_HASH)
    expect(result.receipt.transactionHash).toBe(REPLACEMENT_HASH)
    expect(lifecycle.map((event) => event.status)).toEqual(["submitted", "replaced", "confirmed"])
  })

  it("rejects invalid hashes and reverted receipts", async () => {
    const lifecycle = []
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "reverted",
        blockNumber: 8n,
        transactionHash: HASH,
      })),
    }
    await expect(waitForSuccessfulReceipt(publicClient, "0x1234")).rejects.toMatchObject({
      code: "INVALID_TRANSACTION_HASH",
    })
    await expect(
      waitForSuccessfulReceipt(publicClient, HASH, {
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_REVERTED",
      txHash: HASH,
    })
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]).toMatchObject({
      status: "reverted",
      final: true,
      txHash: HASH,
      submittedHash: HASH,
    })
  })

  it("keeps the lifecycle pending when an RPC returns no known receipt status", async () => {
    const lifecycle = []
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 8n })),
    }

    await expect(
      waitForSuccessfulReceipt(publicClient, HASH, {
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: HASH,
      retryable: false,
      details: { doNotRetry: true, submittedHash: HASH, currentHash: HASH },
    })
    expect(lifecycle).toEqual([
      expect.objectContaining({
        status: "unconfirmed",
        final: false,
        txHash: HASH,
        submittedHash: HASH,
      }),
    ])
  })

  it.each([
    ["success without a transaction hash", { status: "success", blockNumber: 8n }],
    ["reverted without a transaction hash", { status: "reverted", blockNumber: 8n }],
    ["success without a block number", { status: "success", transactionHash: HASH }],
    [
      "reverted with a negative block number",
      { status: "reverted", transactionHash: HASH, blockNumber: -1n },
    ],
  ])("never finalizes a malformed %s receipt", async (_case, receipt) => {
    const lifecycle = []
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => receipt),
    }

    await expect(
      waitForSuccessfulReceipt(publicClient, HASH, {
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "RECEIPT_UNCONFIRMED",
      txHash: HASH,
      retryable: false,
      details: { doNotRetry: true, submittedHash: HASH, currentHash: HASH },
    })
    expect(lifecycle).toEqual([
      expect.objectContaining({
        status: "unconfirmed",
        final: false,
        txHash: HASH,
        submittedHash: HASH,
      }),
    ])
  })

  it("never finalizes a receipt for a different transaction hash", async () => {
    const lifecycle = []
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 8n,
        transactionHash: REPLACEMENT_HASH,
      })),
    }

    await expect(
      waitForSuccessfulReceipt(publicClient, HASH, {
        onTransactionLifecycle: (event) => lifecycle.push(event),
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_RECEIPT_MISMATCH",
      txHash: REPLACEMENT_HASH,
      details: { submittedHash: HASH, replacementHash: null, receiptHash: REPLACEMENT_HASH },
    })
    expect(lifecycle).toEqual([
      expect.objectContaining({
        status: "unconfirmed",
        final: false,
        txHash: HASH,
        submittedHash: HASH,
      }),
    ])
  })
})
