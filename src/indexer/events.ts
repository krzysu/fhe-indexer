import type { Address, Hex } from "viem";

export const confidentialTransferEvent = {
  type: "event" as const,
  name: "ConfidentialTransfer",
  inputs: [
    { type: "address" as const, indexed: true, name: "from" },
    { type: "address" as const, indexed: true, name: "to" },
    { type: "bytes32" as const, indexed: true, name: "encryptedAmount" },
  ],
} as const;

export const wrapEvent = {
  type: "event" as const,
  name: "Wrap",
  inputs: [
    { type: "address" as const, indexed: true, name: "from" },
    { type: "uint256" as const, name: "clearAmount" },
    { type: "bytes32" as const, name: "encryptedAmount" },
  ],
} as const;

export const unwrapFinalizedEvent = {
  type: "event" as const,
  name: "UnwrapFinalized",
  inputs: [
    { type: "address" as const, indexed: true, name: "receiver" },
    { type: "bytes32" as const, indexed: true, name: "unwrapRequestId" },
    { type: "bytes32" as const, name: "encryptedAmount" },
    { type: "uint64" as const, name: "cleartextAmount" },
  ],
} as const;

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

export type WrapLog = {
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  args: {
    from: Address;
    clearAmount: bigint;
    encryptedAmount: Hex;
  };
};

export type UnwrapFinalizedLog = {
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  args: {
    receiver: Address;
    unwrapRequestId: Hex;
    encryptedAmount: Hex;
    cleartextAmount: bigint;
  };
};
