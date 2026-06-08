# Scripts

## e2e-setup.ts

End-to-end test script that mints tokens, shields, delegates decryption, and does a confidential transfer — so you can verify the indexer picks everything up.

### Prerequisites

- `.env` with `SEPOLIA_RPC_URL`, `CONTRACT_ADDRESS`, and `TEST_WALLET_KEY`.
- `INDEXER_PRIVATE_KEY` in `.env` if you want to test delegation + decryption.
- Sepolia ETH in the test wallet (for gas).

### Usage

```bash
# Generate a test wallet (one-time)
pnpm tsx scripts/e2e-setup.ts generate-key

# Add the printed key to your .env:
#   TEST_WALLET_KEY=0x...

# Fund that address with Sepolia ETH

# Run the full flow
pnpm tsx scripts/e2e-setup.ts
```

### What it does

1. Reads the underlying USDC mock balance
2. **Mints** 10 USDC mock if balance is zero
3. **Shields** 1 USDC (wraps into confidential cUSDC)
4. **Delegates** decryption to the indexer EOA (if `INDEXER_PRIVATE_KEY` is set)
5. **Confidential transfer** of 0.1 cUSDC to self

### Verify after running

```bash
# Check the indexer picked up the transfer
curl "http://localhost:3000/api/v1/transfers/<YOUR_WALLET_ADDRESS>"

# Retry no-rights entries (if delegation was granted after initial indexing)
curl -X POST "http://localhost:3000/api/v1/admin/retry-no-rights?address=<YOUR_WALLET_ADDRESS>"
```

After the 2-minute Gateway propagation window, the worker decrypted amount should appear in the API response.

### Example output

```
$ pnpm tsx scripts/e2e-setup.ts

Wallet:            0xC08eef8A0A4a127ad9f122e4d3F080FC92B7a8b0
ETH balance:       0.009739889775620716 ETH
Contract:          0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639
Underlying USDC:   0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF
USDC balance:      10 USDC

Shielding 1 cUSDC...
Shield tx:         0xae905b5b2e26c995a736aa1cf73175315ed9f9791f3b09f6809143a23025e9a1
Conf balance:      1 cUSDC
Indexer address:   0x12c7D7D32649E6336789f5dcFc032BE6Cb66aa4D
Delegating decryption to indexer...
Delegation granted — wait 2 min for Gateway propagation

Confidential transfer: 0.1 cUSDC to self...
Transfer tx:       0x70e0e7bc1db3ec553d852567c8175f1e2370b51028be8419e80d4341dbeec9c8

Done! Check your indexer:
curl http://localhost:3000/api/v1/transfers/0xC08eef8A0A4a127ad9f122e4d3F080FC92B7a8b0
```
