import type { Address, Hex } from "viem";

export type ParsedTransferEvent = {
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  eventType: "transfer" | "shield" | "unshield";
  from: Address;
  to: Address;
  encryptedHandle: Hex | null;
  clearAmount: bigint | null;
};
