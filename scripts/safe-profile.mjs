import {
  concat,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  pad,
  zeroAddress,
} from "viem"

export const safeProfile = Object.freeze({
  version: "1.4.1",
  singleton: getAddress("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"),
  singletonRuntimeCodehash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  proxyFactory: getAddress("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"),
  proxyFactoryRuntimeCodehash: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  proxyCreationCodehash: "0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f",
  proxyRuntimeCodehash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  fallbackHandler: getAddress("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"),
  fallbackHandlerRuntimeCodehash:
    "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  sentinel: getAddress("0x0000000000000000000000000000000000000001"),
  guardStorageSlot: BigInt("0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8"),
  fallbackHandlerStorageSlot: BigInt(
    "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
  ),
})

export const safeAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owners", type: "address[]" },
      { name: "threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "masterCopy",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getModulesPaginated",
    stateMutability: "view",
    inputs: [
      { name: "start", type: "address" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [{ type: "address[]" }, { type: "address" }],
  },
  {
    type: "function",
    name: "getStorageAt",
    stateMutability: "view",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "length", type: "uint256" },
    ],
    outputs: [{ type: "bytes" }],
  },
]

export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "bytes" }],
  },
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: true },
      { name: "singleton", type: "address", indexed: false },
    ],
  },
]

export function requiredAddress(value, label) {
  if (!isAddress(value || "", { strict: false }) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${label} must be a non-zero EVM address.`)
  }
  return getAddress(value)
}

export function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    values[key.slice(2)] = value
    index += 1
  }
  return values
}

export function buildSafeDeployment({ owner, saltNonce, proxyCreationCode }) {
  const normalizedOwner = requiredAddress(owner, "Owner")
  const nonce = BigInt(saltNonce)
  if (nonce < 0n) throw new Error("Safe salt nonce must not be negative.")
  if (typeof proxyCreationCode !== "string" || !/^0x[0-9a-f]*$/i.test(proxyCreationCode)) {
    throw new Error("Safe proxy creation code is invalid.")
  }

  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      [normalizedOwner],
      1n,
      zeroAddress,
      "0x",
      safeProfile.fallbackHandler,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  })
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), nonce]))
  const bytecode = concat([proxyCreationCode, pad(safeProfile.singleton, { size: 32 })])
  const predictedSafe = getContractAddress({
    bytecode,
    from: safeProfile.proxyFactory,
    opcode: "CREATE2",
    salt,
  })
  const transactionData = encodeFunctionData({
    abi: safeProxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [safeProfile.singleton, initializer, nonce],
  })

  return Object.freeze({ initializer, predictedSafe, salt, transactionData })
}

export function assertPinnedBytecode(bytecode, expectedCodehash, label) {
  if (typeof bytecode !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode)) {
    throw new Error(`${label} has no valid deployed bytecode.`)
  }
  if (typeof expectedCodehash !== "string" || !/^0x[0-9a-f]{64}$/i.test(expectedCodehash)) {
    throw new Error(`${label} expected codehash is invalid.`)
  }

  const actualCodehash = keccak256(bytecode)
  if (actualCodehash.toLowerCase() !== expectedCodehash.toLowerCase()) {
    throw new Error(`${label} codehash mismatch.`)
  }
  return actualCodehash
}

export function validateSafeCreationEvidence({ safeAddress, expectedOwner, transaction, receipt }) {
  const safe = requiredAddress(safeAddress, "Protocol Safe")
  const owner = requiredAddress(expectedOwner, "Expected Safe owner")
  if (!transaction || !receipt)
    throw new Error("Safe creation transaction and receipt are required.")
  if (!transaction.to || getAddress(transaction.to) !== safeProfile.proxyFactory) {
    throw new Error("Safe was not created through the pinned proxy factory transaction.")
  }
  if (!transaction.from || getAddress(transaction.from) !== owner) {
    throw new Error("Safe creation transaction sender is not the expected owner.")
  }
  if (receipt.status !== "success") throw new Error("Safe creation transaction did not succeed.")
  if (transaction.hash && receipt.transactionHash && transaction.hash !== receipt.transactionHash) {
    throw new Error("Safe creation transaction and receipt hashes do not match.")
  }

  let call
  try {
    call = decodeFunctionData({ abi: safeProxyFactoryAbi, data: transaction.input })
  } catch {
    throw new Error("Safe creation transaction calldata is invalid.")
  }
  if (call.functionName !== "createProxyWithNonce") {
    throw new Error("Safe creation transaction did not call createProxyWithNonce.")
  }

  for (const log of receipt.logs || []) {
    if (getAddress(log.address) !== safeProfile.proxyFactory) continue
    try {
      const event = decodeEventLog({
        abi: safeProxyFactoryAbi,
        eventName: "ProxyCreation",
        data: log.data,
        topics: log.topics,
        strict: true,
      })
      if (getAddress(event.args.proxy) !== safe) continue
      if (getAddress(event.args.singleton) !== getAddress(call.args[0])) {
        throw new Error("Safe ProxyCreation singleton does not match factory calldata.")
      }
      return Object.freeze({
        transactionHash: transaction.hash || receipt.transactionHash,
        factory: safeProfile.proxyFactory,
        creationSingleton: getAddress(event.args.singleton),
      })
    } catch (error) {
      if (error instanceof Error && /singleton does not match/i.test(error.message)) throw error
    }
  }

  throw new Error("Safe creation receipt has no matching ProxyCreation event.")
}

export function storageWordAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} returned an invalid storage word.`)
  }
  return getAddress(`0x${value.slice(-40)}`)
}
