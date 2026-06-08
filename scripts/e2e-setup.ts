import "dotenv/config";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia as zamaSepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";

if (process.argv[2] === "generate-key") {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  console.log(`Wallet address: ${account.address}`);
  console.log(`Private key:    ${pk}`);
  console.log("");
  console.log("Add this to your .env:");
  console.log(`TEST_WALLET_KEY=${pk}`);
  console.log("");
  console.log("Then fund it with Sepolia ETH at https://sepoliafaucet.com");
  console.log("Then run: pnpm tsx scripts/e2e-setup.ts");
  process.exit(0);
}

if (!process.env.CONTRACT_ADDRESS) {
  console.error("CONTRACT_ADDRESS is required");
  process.exit(1);
}
const CONTRACT = process.env.CONTRACT_ADDRESS as Address;
const RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const WALLET_KEY = process.env.TEST_WALLET_KEY;
const INDEXER_KEY = process.env.INDEXER_PRIVATE_KEY;

if (!WALLET_KEY) {
  console.error("TEST_WALLET_KEY is required — set it in .env");
  console.error("Generate one: pnpm tsx scripts/e2e-setup.ts generate-key");
  process.exit(1);
}

async function main() {
  const transport = http(RPC_URL);
  const walletAccount = privateKeyToAccount(WALLET_KEY as Address);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({
    account: walletAccount,
    chain: sepolia,
    transport,
  });

  console.log(`Wallet:            ${walletAccount.address}`);
  const ethBalance = await publicClient.getBalance({
    address: walletAccount.address,
  });
  console.log(`ETH balance:       ${formatEther(ethBalance)} ETH`);
  console.log(`Contract:          ${CONTRACT}`);

  const chain = {
    ...zamaSepolia,
    network: RPC_URL,
  } as const satisfies FheChain;
  const sdk = new ZamaSDK(
    createConfig({
      chains: [chain],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: { [zamaSepolia.id]: node() },
    }),
  );

  const token = sdk.createWrappedToken(CONTRACT);
  const underlying = await token.underlying();
  console.log(`Underlying USDC:   ${underlying}`);

  const ERC20_ABI = [
    {
      type: "function",
      name: "balanceOf",
      inputs: [{ type: "address" }],
      outputs: [{ type: "uint256" }],
    },
    {
      type: "function",
      name: "mint",
      inputs: [{ type: "address" }, { type: "uint256" }],
      outputs: [],
    },
    {
      type: "function",
      name: "approve",
      inputs: [{ type: "address" }, { type: "uint256" }],
      outputs: [{ type: "bool" }],
    },
  ] as const;

  const getBalance = async () =>
    publicClient.readContract({
      address: underlying,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAccount.address],
    }) as Promise<bigint>;

  const SHIELD_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
  const MINT_AMOUNT = 10_000_000n; // 10 USDC

  let balance = await getBalance();
  console.log(`USDC balance:      ${formatUnits(balance, 6)} USDC`);

  if (balance < SHIELD_AMOUNT) {
    console.log(
      `Balance too low for shield (${formatUnits(balance, 6)} < ${formatUnits(SHIELD_AMOUNT, 6)}), minting...`,
    );
    const mintHash = await walletClient.writeContract({
      address: underlying,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [walletAccount.address, MINT_AMOUNT],
      chain: sepolia,
      account: walletAccount,
    });
    console.log(`Mint tx:           ${mintHash}`);
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    balance = await getBalance();
    console.log(`USDC balance:      ${formatUnits(balance, 6)} USDC`);
  }

  // Step 1: Shield (wrap) some USDC into confidential tokens
  // SDK handles approve (incl. USDC-style reset-to-zero) + wrap internally
  console.log("");
  console.log(`Shielding ${formatUnits(SHIELD_AMOUNT, 6)} cUSDC...`);
  const shieldTx = await token.shield(SHIELD_AMOUNT);

  // Step 2: Check confidential balance
  const confBalance = await token.balanceOf(walletAccount.address);
  console.log(`Conf balance:      ${formatUnits(confBalance, 6)} cUSDC`);

  // Step 3: Delegate decryption to indexer (if INDEXER_PRIVATE_KEY is set)
  if (INDEXER_KEY) {
    const indexerAccount = privateKeyToAccount(INDEXER_KEY as Address);
    console.log(`Indexer address:   ${indexerAccount.address}`);
    console.log("Delegating decryption to indexer...");
    await sdk.delegations.delegateDecryption({
      contractAddress: CONTRACT,
      delegateAddress: indexerAccount.address,
    });
    console.log("Delegation granted — wait 2 min for Gateway propagation");
  } else {
    console.log("INDEXER_PRIVATE_KEY not set — skipping delegation");
  }

  // Step 4: Confidential transfer (send 100k to self for testing)
  const TRANSFER_AMOUNT = 100_000n;
  console.log("");
  console.log(
    `Confidential transfer: ${formatUnits(TRANSFER_AMOUNT, 6)} cUSDC to self...`,
  );
  const transferTx = await token.confidentialTransfer(
    walletAccount.address,
    TRANSFER_AMOUNT,
  );
  console.log(`Transfer tx:       ${transferTx.txHash}`);

  console.log("");
  console.log("Done! Check your indexer:");
  console.log(
    `curl http://localhost:3000/api/v1/transfers/${walletAccount.address}`,
  );
}

main().catch(console.error);
