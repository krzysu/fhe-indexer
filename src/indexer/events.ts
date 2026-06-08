export const confidentialTransferEvent = {
  type: "event" as const,
  name: "ConfidentialTransfer",
  inputs: [
    { type: "address" as const, indexed: true, name: "from" },
    { type: "address" as const, indexed: true, name: "to" },
    { type: "bytes32" as const, indexed: true, name: "encryptedAmount" },
  ],
} as const;

import type { Address, Hex } from "viem";

export type ConfidentialTransferLog = {
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  args: {
    from: Address;
    to: Address;
    encryptedAmount: Hex;
  };
};
