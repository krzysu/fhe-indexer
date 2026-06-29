import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

/** Module-level singleton; lifecycle tied to the Node process. */
let sdk: ZamaSDK | null = null;

/**
 * Builds the Zama SDK with viem-flavoured config:
 *   - `publicClient` / `walletClient` from the same RPC and EOA key,
 *   - `MemoryStorage` for ephemeral ACL/signatures (no disk persistence),
 *   - `node()` relayer for Gateway decryption requests.
 * Idempotent: returns the existing instance on repeat calls.
 * Side effects: imports the `sepolia` chain definition from `@zama-fhe/sdk/chains`
 * and overrides its RPC URL with ours (the SDK ships a default).
 */
export function initSdk(rpcUrl: string, privateKey: string): ZamaSDK {
  if (sdk) return sdk;

  const transport = http(rpcUrl);
  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ chain: viemSepolia, transport });
  const walletClient = createWalletClient({
    account,
    chain: viemSepolia,
    transport,
  });

  const zamaSepolia = {
    ...sepolia,
    network: rpcUrl,
  } as const satisfies FheChain;

  sdk = new ZamaSDK(
    createConfig({
      chains: [zamaSepolia],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: { [zamaSepolia.id]: node() },
    }),
  );

  return sdk;
}

/**
 * Tears down the SDK and clears the singleton. Called from the shutdown
 * handler so background SDK tasks (e.g. relayer timers) don't keep the
 * process alive after `app.close()`.
 */
export function terminateSdk(): void {
  if (sdk) {
    sdk.terminate();
    sdk = null;
  }
}
