import type { Hex } from "viem";
import type { ZamaSDK } from "@zama-fhe/sdk";
import {
  DelegationNotFoundError,
  DelegationNotPropagatedError,
} from "@zama-fhe/sdk";
import type { Db } from "../db/connection.js";
import {
  dequeueBatch,
  requeueWithBackoff,
  deleteQueueEntry,
} from "../db/queue.js";
import {
  updateTransferDecryptStatus,
  getTransferById,
  getFullTransferById,
} from "../db/transfers.js";
import { markTransferDecrypted } from "../db/balances.js";

/** Worker tick interval. 1s balances Gateway latency vs. throughput. */
const POLL_INTERVAL = 1_000;

/** Max decrypt jobs processed per tick. Caps Gateway concurrency + RPC burst. */
const BATCH_SIZE = 5;

/**
 * Special-case backoff for `DelegationNotPropagatedError`: rights exist on
 * chain but the Gateway hasn't seen them yet. A longer, fixed delay gives
 * the propagation time to settle before retry.
 */
const PROPAGATION_DELAY_MS = 60_000;

/**
 * Single `delegatedDecrypt` call against the Zama Gateway. The `delegator`
 * is the EOA whose ACL grant should authorise this decryption (sender,
 * receiver, or an external grant). Throws on failure — caller handles
 * retry semantics.
 */
async function tryDecrypt(
  sdk: ZamaSDK,
  handle: string,
  contractAddress: string,
  delegator: string,
): Promise<bigint> {
  const result = await sdk.decryption.delegatedDecrypt(
    [
      {
        encryptedValue: handle as Hex,
        contractAddress: contractAddress as Hex,
      },
    ],
    delegator as Hex,
  );
  return result[handle] as bigint;
}

/**
 * Try to decrypt a handle by trying both parties as the delegator.
 *   - sender first (most common: indexer EOA = sender or has sender's grant),
 *   - if `DelegationNotFoundError`, fall back to the receiver,
 *   - if that also fails with `DelegationNotFoundError`, return `null`
 *     (terminal: no rights). Other errors propagate for the worker to
 *     apply backoff / max-attempts logic.
 * The `to === from` short-circuit avoids a guaranteed second failure
 * for self-transfers.
 */
async function decryptWithRetry(
  sdk: ZamaSDK,
  handle: string,
  contractAddress: string,
  fromAddress: string,
  toAddress: string,
): Promise<bigint | null> {
  try {
    return await tryDecrypt(sdk, handle, contractAddress, fromAddress);
  } catch (err) {
    if (err instanceof DelegationNotFoundError) {
      if (toAddress === fromAddress) return null;
      try {
        return await tryDecrypt(sdk, handle, contractAddress, toAddress);
      } catch (err2) {
        if (err2 instanceof DelegationNotFoundError) return null;
        throw err2;
      }
    }
    throw err;
  }
}

/**
 * Drains up to `limit` ready decrypt jobs and processes them in parallel
 * via `Promise.allSettled` (so one job's failure doesn't sink the rest).
 * Outcomes per job:
 *   - fulfilled + non-null → `decrypt_status = "decrypted"`, balance delta applied,
 *   - fulfilled + null      → `no_rights` (no delegation), queue row deleted,
 *   - rejected + exhausted  → `no_rights`, queue row deleted,
 *   - rejected + propagation → requeue with 60s delay,
 *   - rejected + other      → requeue with exponential backoff.
 */
async function processBatch(
  db: Db,
  sdk: ZamaSDK,
  limit: number,
): Promise<void> {
  const jobs = dequeueBatch(db, limit);
  if (jobs.length === 0) return;

  console.log(`[worker] decrypting ${jobs.length} job(s)`);

  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const transfer = getTransferById(db, job.transfer_id);
      console.log(
        `[worker] job #${job.id}: transfer #${job.transfer_id} from=${transfer?.from_address} to=${transfer?.to_address} attempt=${job.attempts + 1}/${job.max_attempts}`,
      );
      return decryptWithRetry(
        sdk,
        job.encrypted_handle,
        job.contract_address,
        transfer?.from_address ?? "0x",
        transfer?.to_address ?? "0x",
      );
    }),
  );

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const result = results[i];
    if (!job || !result) continue;

    if (result.status === "fulfilled") {
      if (result.value !== null) {
        console.log(
          `[worker] job #${job.id}: decrypted ✓ (amount: ${result.value})`,
        );
        updateTransferDecryptStatus(
          db,
          job.transfer_id,
          "decrypted",
          result.value,
        );
        const transfer = getFullTransferById(db, job.transfer_id);
        if (transfer) {
          markTransferDecrypted(db, transfer);
        }
      } else {
        console.log(`[worker] job #${job.id}: no rights`);
        updateTransferDecryptStatus(db, job.transfer_id, "no_rights");
      }
      deleteQueueEntry(db, job.id);
    } else {
      const reason = result.reason;
      const errMsg =
        (reason as { message?: string })?.message ?? String(reason);
      if (job.attempts + 1 >= job.max_attempts) {
        console.log(
          `[worker] job #${job.id}: exhausted (max attempts), marking no_rights`,
        );
        updateTransferDecryptStatus(db, job.transfer_id, "no_rights");
        deleteQueueEntry(db, job.id);
      } else if (reason instanceof DelegationNotPropagatedError) {
        console.log(
          `[worker] job #${job.id}: delegation not propagated, backoff ${PROPAGATION_DELAY_MS / 1000}s`,
        );
        requeueWithBackoff(db, job.id, errMsg, PROPAGATION_DELAY_MS);
      } else {
        console.log(
          `[worker] job #${job.id}: error, requeue with backoff: ${errMsg}`,
        );
        requeueWithBackoff(db, job.id, errMsg);
      }
    }
  }
}

/**
 * Bootstraps the 1s decrypt-worker loop. Errors are caught inside the tick
 * so a transient SDK failure doesn't kill the loop. Returns a stop function
 * for the shutdown handler (cancels the pending timer and refuses further
 * ticks via the `running` flag).
 */
export function startWorker(db: Db, sdk: ZamaSDK): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      await processBatch(db, sdk, BATCH_SIZE);
    } catch (err) {
      console.error("[worker] error:", err);
    }
    timer = setTimeout(tick, POLL_INTERVAL);
  }

  timer = setTimeout(tick, 0);

  return () => {
    running = false;
    if (timer) clearTimeout(timer);
  };
}
