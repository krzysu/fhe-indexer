import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

let sdk: ZamaSDK | null = null;

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

export function terminateSdk(): void {
  if (sdk) {
    sdk.terminate();
    sdk = null;
  }
}
