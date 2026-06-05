# Zama SDK v3.1.0-alpha.4 — Reference for Confidential Token Indexer

**Source of truth:** Local checkout tagged `v3.1.0-alpha.4`.

**Critical warning:** The examples at `examples/node-viem/` and `examples/node-ethers/` reference `@zama-fhe/sdk` v3.0.0-alpha.34, which has a **different API**. This document reflects the actual v3.1.0-alpha.4 API, not the examples. See §7 for the full diff.

---

## 1. Package & Imports

```
npm i @zama-fhe/sdk@alpha
# → installs v3.1.0-alpha.4
```

**Node.js >=22 required.**

| Sub-path | Import | Purpose |
|----------|--------|---------|
| `@zama-fhe/sdk` | `ZamaSDK`, `MemoryStorage`, error classes | Core SDK |
| `@zama-fhe/sdk/viem` | `createConfig` | Viem adapter |
| `@zama-fhe/sdk/node` | `node` | Node.js relayer transport |
| `@zama-fhe/sdk/chains` | `sepolia`, `FheChain` | Chain presets |
| `viem` | `createPublicClient`, `createWalletClient`, `http` | EVM interaction |

```typescript
import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import type { Address } from "@zama-fhe/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";
```

---

## 2. SDK Initialization

### 2.1 viem flavour (recommended for our indexer)

```typescript
const transport = http(SEPOLIA_RPC_URL);
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: viemSepolia, transport });
const walletClient = createWalletClient({ account, chain: viemSepolia, transport });

const zamaSepolia = {
  ...sepolia,
  network: SEPOLIA_RPC_URL,
  ...(RELAYER_API_KEY && {
    auth: { __type: "ApiKeyHeader" as const, value: RELAYER_API_KEY },
  }),
} as const satisfies FheChain;

using sdk = new ZamaSDK(
  createConfig({
    chains: [zamaSepolia],
    publicClient,
    walletClient,
    storage: new MemoryStorage(),
    relayers: {
      [zamaSepolia.id]: node(),
    },
  }),
);
```

### 2.2 ethers flavour (alternative)

```typescript
import { JsonRpcProvider, Wallet } from "ethers";
import { createConfig } from "@zama-fhe/sdk/ethers";

const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

using sdk = new ZamaSDK(
  createConfig({
    chains: [zamaSepolia],
    signer: wallet,
    storage: new MemoryStorage(),
    relayers: { [zamaSepolia.id]: node() },
  }),
);
```

### 2.3 Lifecycle

The `using` keyword (TypeScript 5.2+) calls `sdk[Symbol.dispose]()` → `sdk.terminate()` on scope exit, which shuts down the relayer worker pool. Without `using`, call `sdk.terminate()` explicitly.

---

## 3. Registry Lookup

Before interacting with a confidential token, resolve its address via the on-chain Wrappers Registry:

```typescript
// Underlying ERC-20 → confidential token address
const registryResult = await sdk.registry.getConfidentialToken(
  "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF", // USDC Mock
);

if (!registryResult) {
  throw new Error("No confidential wrapper registered");
}
if (!registryResult.isValid) {
  throw new Error("Wrapper registration is revoked or invalid");
}

const confidentialTokenAddress = registryResult.confidentialTokenAddress;
// → 0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639
```

The registry is auto-configured for Sepolia (address `0x2f0750Bbb0A246059d80e94c454586a7F27a128e`).

---

## 4. Token API

### 4.1 Create a Token

```typescript
const token = sdk.createToken(confidentialTokenAddress);
```

### 4.2 Read Metadata

```typescript
const name = await token.name();      // "Confidential USDC (Mock)"
const symbol = await token.symbol();  // "cUSDCMock"
const decimals = await token.decimals(); // 6
```

### 4.3 Balance (auto-decrypt)

```typescript
// Decrypts the caller's own balance
const myBalance = await token.balanceOf(indexerEOAAddress);
// Returns bigint, e.g. 1000000n
```

`balanceOf()` internally:
1. Calls `confidentialBalanceOf(owner)` on the ERC-7984 contract → returns an `EncryptedValue` handle
2. Calls `sdk.decryption.userDecrypt()` with the handle
3. Returns the decrypted `bigint`

### 4.4 Raw Encrypted Balance

```typescript
const encryptedHandle = await token.confidentialBalanceOf(ownerAddress);
// Returns EncryptedValue (a bytes32 hex string)
```

### 4.5 Delegated Balance Decryption

```typescript
const balanceAsDelegate = await token.decryptBalanceAs({
  delegatorAddress: holderAddress,
  // accountAddress?: defaults to delegatorAddress
});
// Decrypts the holder's balance using ACL delegation credentials
```

---

## 5. Event Decoders

The SDK exports framework-agnostic event decoders that work with raw logs from any provider (viem, ethers, direct RPC).

### 5.1 RawLog Type

```typescript
interface RawLog {
  readonly topics: readonly Hex[];  // index signatures
  readonly data: Hex;               // ABI-encoded non-indexed params
}
```

viem's `getLogs` returns logs compatible with this type — pass them directly.

### 5.2 Token Event Topic Hashes

```typescript
import { Topics, TOKEN_TOPICS } from "@zama-fhe/sdk";

Topics.ConfidentialTransfer
// keccak256("ConfidentialTransfer(address,address,bytes32)")

Topics.Wrapped
// keccak256("Wrapped(address,uint256)")

Topics.UnwrapRequested
// keccak256("UnwrapRequested(address,bytes32,bytes32)")

Topics.UnwrapFinalized
// keccak256("UnwrapFinalized(address,bytes32,bytes32,uint64)")

// Fetch all token events in one call:
const logs = await publicClient.getLogs({
  address: confidentialTokenAddress,
  topics: [TOKEN_TOPICS],
  fromBlock,
  toBlock,
});
```

### 5.3 ConfidentialTransfer Decoder

```typescript
import { decodeConfidentialTransfer } from "@zama-fhe/sdk";

const event = decodeConfidentialTransfer(log);
if (event) {
  // event.eventName === "ConfidentialTransfer"
  // event.from: Address          — cleartext sender
  // event.to: Address            — cleartext receiver
  // event.encryptedAmountHandle: EncryptedValue  — bytes32 FHE handle
}
```

Note: All three params are **indexed** in the Solidity event, so the encrypted amount handle lives in `topics[3]`, not `data`. The decoder handles this.

### 5.4 Shield/Unshield Decoders

New wrapper contracts emit `ConfidentialTransfer(from=zeroAddress, ...)` for shields instead of the legacy `Wrapped` event. The SDK retains backwards-compatible decoders for both.

For shields, look for `ConfidentialTransfer` where `from === zeroAddress`.

### 5.5 Batch Decode

```typescript
import { decodeOnChainEvents } from "@zama-fhe/sdk";

const events = decodeOnChainEvents(logs);
// Returns array of typed event objects
// Unrecognized logs are skipped (null filtered out)
```

### 5.6 ACL Event Decoders

```typescript
import { AclTopics, ACL_TOPICS, decodeAclEvents } from "@zama-fhe/sdk";

// Fetch ACL events:
const aclLogs = await publicClient.getLogs({
  address: sepolia.aclContractAddress,  // 0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D
  topics: [ACL_TOPICS],
  fromBlock,
  toBlock,
});

const aclEvents = decodeAclEvents(aclLogs);
// Each event is DelegatedForUserDecryptionEvent | RevokedDelegationForUserDecryptionEvent
```

---

## 6. Decryption API

### 6.1 Direct Decryption (`sdk.decryption.userDecrypt`)

Decrypts handles the indexer has direct rights to (as a transfer party, or via a signed permit):

```typescript
import { type EncryptedInput } from "@zama-fhe/sdk";

const encryptedInput: EncryptedInput[] = [{
  encryptedValue: handle,        // EncryptedValue (bytes32 from event)
  contractAddress: tokenAddress,  // Address
}];

const result = await sdk.decryption.userDecrypt(encryptedInput);
const cleartext = result[handle]; // bigint
```

**Important API change from v3.0.0:** The field is now `encryptedValue` (not `handle`), and the type is `EncryptedInput[]` (not `DecryptHandle[]`).

**Caching:** Results are cached — repeated calls for the same value skip the relayer round-trip. Zero handles map to `0n` without a relayer call.

### 6.2 Delegated Decryption (`sdk.decryption.delegatedDecrypt`)

Decrypts handles using ACL delegation rights (when someone else granted the indexer EOA decryption rights):

```typescript
const result = await sdk.decryption.delegatedDecrypt(
  [{ encryptedValue: handle, contractAddress: tokenAddress }],
  delegatorAddress,    // The address that granted delegation
  // accountAddress?:   // defaults to delegatorAddress
);
```

Pre-flight checks: each contract must have an active delegation. Fails fast with `DelegationNotFoundError` if not.

**Indexer usage:** The periodic retry sweep uses this API with the delegator address stored alongside the pending transfer.

### 6.3 Batch Delegated Decryption

```typescript
const result = await sdk.decryption.delegatedBatchDecrypt({
  encryptedInputs: [
    { encryptedValue: handle1, contractAddress: tokenAddr },
    { encryptedValue: handle2, contractAddress: tokenAddr },
  ],
  delegatorAddress: holderAddr,
  maxConcurrency: 5,
});
// result.items: Array of { encryptedValue, value?: bigint, error?: Error }
// Per-entry error isolation — healthy entries still resolve
```

### 6.4 Public Decryption

No signer required. Returns decryption proof alongside cleartext:

```typescript
const { clearValues, decryptionProof, abiEncodedClearValues } =
  await sdk.decryption.publicDecrypt([encryptedHandle]);
```

---

## 7. Delegation API

**In v3.1.0-alpha.4, all delegation methods live on `sdk.delegations.*`, NOT on `token`.**

### 7.1 Grant Delegation

```typescript
await sdk.delegations.delegateDecryption({
  contractAddress: confidentialTokenAddress,
  delegateAddress: indexerEOAAddress,
  // expirationDate?: Date  // defaults to permanent (uint64.max)
});
```

**Important:** After the transaction is mined, allow **1–2 minutes** before attempting delegated decryption. The gateway must sync the ACL state via cross-chain event propagation. During this window, `delegatedDecrypt` throws `DelegationNotPropagatedError`.

### 7.2 Check Delegation

```typescript
const isActive = await sdk.delegations.isActive({
  contractAddress: confidentialTokenAddress,
  delegatorAddress: holderAddress,
  delegateAddress: indexerEOAAddress,
});
// Returns boolean
```

### 7.3 Get Expiry

```typescript
const expiry = await sdk.delegations.getExpiry({
  contractAddress: confidentialTokenAddress,
  delegatorAddress: holderAddress,
  delegateAddress: indexerEOAAddress,
});
// 0n = no delegation
// 2n ** 64n - 1n = permanent
// else: Unix timestamp as bigint
```

### 7.4 Revoke Delegation

```typescript
await sdk.delegations.revokeDelegation({
  contractAddress: confidentialTokenAddress,
  delegateAddress: indexerEOAAddress,
});
```

---

## 8. Permit API

The `sdk.permits.*` namespace manages EIP-712 signed permits (required for the relayer to authorize re-encryption requests).

```typescript
// Sign permits for direct decryption on these contracts
await sdk.permits.grantPermit([confidentialTokenAddress]);

// Sign delegation permits (for delegated decryption)
await sdk.permits.grantDelegationPermit(delegatorAddress, [confidentialTokenAddress]);

// Check cached permits
const hasPermit = await sdk.permits.hasPermit([confidentialTokenAddress]);
const hasDelegationPermit = await sdk.permits.hasDelegationPermit(delegatorAddress, [confidentialTokenAddress]);

// Prefetch keypair (latency optimization)
await sdk.permits.warmKeypair();
```

In practice, the SDK auto-generates permits lazily on first `userDecrypt` or `delegatedDecrypt` call — explicit `grantPermit` is optional but avoids a wallet-signature delay on the first decrypt.

---

## 9. Error Classes

All exported from `@zama-fhe/sdk`:

```typescript
import {
  // Decryption
  DecryptionFailedError,
  NoCiphertextError,

  // Delegation
  DelegationNotFoundError,        // No delegation exists → store as 'no_rights'
  DelegationNotPropagatedError,   // ACL not yet synced → retry after 30s
  DelegationExpiredError,         // Delegation was valid but expired
  DelegationSelfNotAllowedError,
  DelegationExpiryUnchangedError,

  // Signing
  SigningRejectedError,
  SigningFailedError,

  // Relayer
  RelayerRequestFailedError,      // Network/HTTP error → retry

  // General
  ConfigurationError,
  ChainMismatchError,
  SignerNotConfiguredError,
} from "@zama-fhe/sdk";
```

### Error Handling Pattern

```typescript
async function decryptHandle(handle: string, contractAddress: string): Promise<bigint | null> {
  try {
    const result = await sdk.decryption.userDecrypt([
      { encryptedValue: handle as `0x${string}`, contractAddress: contractAddress as `0x${string}` },
    ]);
    return result[handle] as bigint;
  } catch (err) {
    if (err instanceof DelegationNotFoundError) return null; // → 'no_rights'
    // DelegationNotPropagatedError → retry after delay
    // DecryptionFailedError, RelayerRequestFailedError → retry with backoff
    throw err;
  }
}
```

---

## 10. ZamaSDK Public API Reference

### Properties

```typescript
sdk.relayer      // RelayerDispatcher — low-level relayer access
sdk.provider     // GenericProvider — read contract calls
sdk.signer       // GenericSigner | undefined — write capabilities
sdk.storage      // GenericStorage — credential/keypair persistence
sdk.registry     // WrappersRegistry — token ↔ underlying resolution
sdk.permits      // Permits — EIP-712 permit management
sdk.delegations  // Delegations — on-chain ACL delegation
sdk.decryption   // Decryption — FHE decrypt operations
```

### Methods

```typescript
sdk.createToken(address: Address): Token
sdk.createWrappedToken(address: Address): WrappedToken
sdk.createWrappersRegistry(registryAddresses?: Record<number, Address>): WrappersRegistry
sdk.encrypt(params: EncryptParams): Promise<EncryptResult>
sdk.onWalletAccountChange(listener): () => void
sdk.dispose(): void    // Unsubscribe lifecycle, keep relayer
sdk.terminate(): void  // Full cleanup
```

---

## 11. Complete Indexer Flow

Full sequence from event fetch to cleartext storage:

```typescript
// ── Step 1: SDK initialization (startup) ──
using sdk = new ZamaSDK(createConfig({ ... }));

// ── Step 2: Fetch logs ──
const logs = await publicClient.getLogs({
  address: confidentialTokenAddress,
  topics: [TOKEN_TOPICS],
  fromBlock: lastBlock + 1,
  toBlock: currentBlock,
});

// ── Step 3: Decode events ──
const events = decodeOnChainEvents(logs);

for (const event of events) {
  if (event.eventName !== "ConfidentialTransfer") continue;

  // ── Step 4: Store raw event (never drop) ──
  const row = db.insertTransfer({
    txHash: event.log.transactionHash,
    blockNumber: event.log.blockNumber,
    from: event.from,
    to: event.to,
    encryptedHandle: event.encryptedAmountHandle,
    decryptStatus: "pending",
  });

  // ── Step 5: Enqueue decrypt job ──
  db.enqueueDecryptJob({
    transferId: row.id,
    encryptedHandle: event.encryptedAmountHandle,
    contractAddress: confidentialTokenAddress,
  });
}

// ── (in the background worker) ──
// Step 6: Attempt decryption
async function processJob(job) {
  try {
    const result = await sdk.decryption.userDecrypt([{
      encryptedValue: job.encryptedHandle,
      contractAddress: job.contractAddress,
    }]);
    const cleartext = result[job.encryptedHandle] as bigint;

    // Step 7: Update storage
    db.updateTransferDecrypted(job.transferId, cleartext);
    db.updateBalance(job.contractAddress, job.from, job.to, cleartext);
  } catch (err) {
    if (err instanceof DelegationNotFoundError) {
      db.updateTransferNoRights(job.transferId);
    } else {
      throw err; // retry
    }
  }
}
```

---

## 12. API Diff: v3.0.0-alpha.34 (examples) vs v3.1.0-alpha.4 (actual)

| Aspect | Old (in examples) | v3.1.0-alpha.4 (actual) |
|--------|-------------------|-------------------------|
| Init function | Use `new ViemSigner()`, `new RelayerNode()`, `new ZamaSDK({relayer, signer, storage})` | Use `createConfig({chains, publicClient, walletClient, storage, relayers})` from `@zama-fhe/sdk/viem`, then `new ZamaSDK(config)` |
| Chain config | `SepoliaConfig` from `relayer-utils.ts` | `sepolia` from `@zama-fhe/sdk/chains`, type `FheChain` |
| Delegation grant | `token.delegateDecryption({delegateAddress})` | `sdk.delegations.delegateDecryption({contractAddress, delegateAddress})` |
| Delegation check | `token.isDelegated({delegatorAddress, delegateAddress})` | `sdk.delegations.isActive({contractAddress, delegatorAddress, delegateAddress})` |
| Delegation expiry | `token.getDelegationExpiry(...)` | `sdk.delegations.getExpiry(...)` |
| Delegation revoke | `token.revokeDelegation({delegateAddress})` | `sdk.delegations.revokeDelegation({contractAddress, delegateAddress})` |
| `allow()` | Exists in old API | **Does not exist.** Use `sdk.permits.grantPermit()` |
| Decrypt param | `sdk.userDecrypt([{handle, contractAddress}])` | `sdk.decryption.userDecrypt([{encryptedValue, contractAddress}])` |
| Decrypt type | `DecryptHandle[]` | `EncryptedInput[]` |
| `readonly-token.ts` | Exists as separate file | **Does not exist.** All on `Token` |
| Delegated decrypt | `token.decryptBalanceAs({delegatorAddress})` | Still `token.decryptBalanceAs({delegatorAddress})` — **unchanged** |
| Event decoders | Manual ABI decoding | Built-in: `decodeConfidentialTransfer`, `decodeOnChainEvents`, etc. |
| `node()` config | `new RelayerNode({getChainId, transports})` | `node()` from `@zama-fhe/sdk/node` — plug into relayers map |
| Storage | `MemoryStorage` from barrel | Same, plus `memoryStorage` singleton |

---

## 13. Sepolia Contract Addresses (SDK Preset)

The SDK's `sepolia` chain config resolves these automatically:

```typescript
sepolia = {
  id: 11155111,
  gatewayChainId: 10901,
  relayerUrl: "https://relayer.testnet.zama.org/v2",
  network: "https://ethereum-sepolia-rpc.publicnode.com",
  aclContractAddress: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
  kmsContractAddress: "0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A",
  inputVerifierContractAddress: "0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0",
  verifyingContractAddressDecryption: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478",
  verifyingContractAddressInputVerification: "0x483b9dE06E4E4C7D35CCf5837A1668487406D955",
  registryAddress: "0x2f0750Bbb0A246059d80e94c454586a7F27a128e",
};
```

Our target token:
- **cUSDCMock (confidential):** `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`
- **USDC Mock (underlying):** `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`

---

## 14. Key Source File Paths (in zama-ai-sdk repo)

| File | What it contains |
|------|-----------------|
| `packages/sdk/src/zama-sdk.ts` | `ZamaSDK` class — constructor, properties, methods |
| `packages/sdk/src/token/token.ts` | `Token` class — balanceOf, decryptBalanceAs, confidentialTransfer, etc. |
| `packages/sdk/src/namespaces/decryption.ts` | `Decryption` — userDecrypt, delegatedDecrypt, publicDecrypt |
| `packages/sdk/src/namespaces/delegations.ts` | `Delegations` — delegateDecryption, revokeDelegation, isActive, getExpiry |
| `packages/sdk/src/namespaces/permits.ts` | `Permits` — grantPermit, grantDelegationPermit, warmKeypair |
| `packages/sdk/src/events/onchain-events.ts` | Event topic hashes, decoders (decodeConfidentialTransfer, etc.) |
| `packages/sdk/src/config/types.ts` | ZamaConfig, ZamaConfigBase, RelayerConfig types |
| `packages/sdk/src/viem/config.ts` | `createConfig` for viem |
| `packages/sdk/src/viem/index.ts` | Viem adapter exports |
| `packages/sdk/src/index.ts` | Main barrel — all public exports |
| `packages/sdk/src/errors/` | All error classes |
| `packages/sdk/src/query/user-decrypt.ts` | `EncryptedInput` type |
| `packages/sdk/src/types/transaction.ts` | `RawLog`, `TransactionResult` types |
