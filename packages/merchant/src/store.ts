import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** One completed payment, as the merchant records it. */
export interface SettledPayment {
  /** The settlement transaction. Unique. */
  txHash: string;
  /** The challenge nonce the payment answered. Unique. */
  nonce: string;
  challengeHash: string;
  /** The payer's policy account (a C address). */
  payer: string;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
  /** The request the payment unlocked, as signed. */
  method: string;
  url: string;
  settledAt: string;
  /** The proof of intent transaction, once it is published. */
  proofTransaction?: string;
}

/**
 * Where a merchant keeps completed payments, so a payment unlocks one
 * response and only one, also across restarts.
 *
 * Both the transaction hash and the nonce have to be unique. A database
 * should enforce that with unique constraints rather than check then write,
 * so two concurrent requests carrying the same payment cannot both pass.
 */
export interface SettlementStore {
  /** Whether the store survives a restart. Mainnet refuses a store that does not. */
  readonly persistent: boolean;
  /** Whether a payment with this nonce was already recorded. */
  hasNonce(nonce: string): Promise<boolean>;
  /** Record a payment. False when its hash or nonce was already recorded. */
  record(payment: SettledPayment): Promise<boolean>;
  /** Note the proof of intent transaction for a recorded payment. */
  markProof(nonce: string, proofTransaction: string): Promise<void>;
  /** Recorded payments whose proof of intent has not been published yet. */
  pendingProofs(): Promise<SettledPayment[]>;
  /** Release whatever the store holds open. */
  close?(): Promise<void>;
}

/** Kept in memory only. For tests and testnet: every payment is forgotten on restart. */
export function memoryStore(): SettlementStore {
  const byNonce = new Map<string, SettledPayment>();
  const hashes = new Set<string>();
  return {
    persistent: false,
    async hasNonce(nonce) {
      return byNonce.has(nonce);
    },
    async record(payment) {
      if (byNonce.has(payment.nonce) || hashes.has(payment.txHash)) return false;
      byNonce.set(payment.nonce, { ...payment });
      hashes.add(payment.txHash);
      return true;
    },
    async markProof(nonce, proofTransaction) {
      const payment = byNonce.get(nonce);
      if (payment) payment.proofTransaction = proofTransaction;
    },
    async pendingProofs() {
      return [...byNonce.values()].filter((p) => !p.proofTransaction);
    },
  };
}

type Line = { kind: "payment"; payment: SettledPayment } | { kind: "proof"; nonce: string; proofTransaction: string };

/**
 * An append-only file, one JSON record per line, flushed to disk before a
 * payment is reported as recorded.
 *
 * It suits a merchant running as one process on one machine. A lock file
 * next to it stops a second process from opening the same file; several
 * instances behind a load balancer need a shared database instead.
 */
export function fileStore(path: string): SettlementStore {
  mkdirSync(dirname(path), { recursive: true });
  takeLock(`${path}.lock`);

  const byNonce = new Map<string, SettledPayment>();
  const hashes = new Set<string>();
  let text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = text.split("\n");
  let torn = false;
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      // A crash mid write can cut the last line short. That record was
      // never reported as written, so it is dropped.
      if (index === lines.length - 1) {
        torn = true;
        return;
      }
      throw new Error(`${path} line ${index + 1} is not a settlement record`);
    }
    if (line.kind === "payment") {
      byNonce.set(line.payment.nonce, line.payment);
      hashes.add(line.payment.txHash);
    } else if (line.kind === "proof") {
      const payment = byNonce.get(line.nonce);
      if (payment) payment.proofTransaction = line.proofTransaction;
    }
  });

  if (torn) {
    // Cut the partial record off, so the file reads cleanly next time too.
    truncateSync(path, Buffer.byteLength(text) - Buffer.byteLength(lines[lines.length - 1]!));
    text = lines.slice(0, -1).join("\n") + "\n";
  }
  const fd = openSync(path, "a");
  // A complete last record whose newline never made it to disk.
  if (text && !text.endsWith("\n")) writeSync(fd, "\n");
  text = "";
  const append = (line: Line) => {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  };

  return {
    persistent: true,
    async hasNonce(nonce) {
      return byNonce.has(nonce);
    },
    async record(payment) {
      // Check and write happen in one synchronous step, so two requests in
      // this process cannot interleave between them.
      if (byNonce.has(payment.nonce) || hashes.has(payment.txHash)) return false;
      append({ kind: "payment", payment });
      byNonce.set(payment.nonce, { ...payment });
      hashes.add(payment.txHash);
      return true;
    },
    async markProof(nonce, proofTransaction) {
      const payment = byNonce.get(nonce);
      if (!payment) return;
      append({ kind: "proof", nonce, proofTransaction });
      payment.proofTransaction = proofTransaction;
    },
    async pendingProofs() {
      return [...byNonce.values()].filter((p) => !p.proofTransaction);
    },
    async close() {
      closeSync(fd);
      releaseLock(`${path}.lock`);
    },
  };
}

const heldLocks = new Set<string>();

function takeLock(lockPath: string): void {
  if (heldLocks.has(lockPath)) {
    throw new Error(`${lockPath} is already open in this process`);
  }
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = Number(readFileSync(lockPath, "utf-8"));
    if (holder && holder !== process.pid && isAlive(holder)) {
      throw new Error(`${lockPath} is held by process ${holder}. One process at a time may use a file store`);
    }
    // Left behind by a process that has gone.
    writeFileSync(lockPath, String(process.pid));
  }
  heldLocks.add(lockPath);
  process.once("exit", () => releaseLock(lockPath));
}

function releaseLock(lockPath: string): void {
  if (!heldLocks.delete(lockPath)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Anything that runs a parameterised SQL query the way node-postgres does. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The table postgresStore() expects. Run it once. */
export const POSTGRES_SCHEMA = `
create table if not exists beaver402_settlements (
  tx_hash text primary key,
  nonce text not null unique,
  challenge_hash text not null,
  payer text not null,
  recipient text not null,
  asset text not null,
  amount text not null,
  network text not null,
  method text not null,
  url text not null,
  settled_at timestamptz not null,
  proof_transaction text
);`;

/**
 * Postgres, through any client with a node-postgres style query(), such as
 * a pg Pool. The unique constraints do the duplicate check, so it is safe
 * with several instances.
 */
export function postgresStore(client: SqlClient, table = "beaver402_settlements"): SettlementStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`${table} is not a plain table name`);
  const fromRow = (row: Record<string, unknown>): SettledPayment => ({
    txHash: String(row.tx_hash),
    nonce: String(row.nonce),
    challengeHash: String(row.challenge_hash),
    payer: String(row.payer),
    recipient: String(row.recipient),
    asset: String(row.asset),
    amount: String(row.amount),
    network: String(row.network),
    method: String(row.method),
    url: String(row.url),
    settledAt: new Date(row.settled_at as string).toISOString(),
    proofTransaction: row.proof_transaction ? String(row.proof_transaction) : undefined,
  });
  return {
    persistent: true,
    async hasNonce(nonce) {
      const { rows } = await client.query(`select 1 from ${table} where nonce = $1`, [nonce]);
      return rows.length > 0;
    },
    async record(p) {
      try {
        await client.query(
          `insert into ${table} (tx_hash, nonce, challenge_hash, payer, recipient, asset, amount, network, method, url, settled_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [p.txHash, p.nonce, p.challengeHash, p.payer, p.recipient, p.asset, p.amount, p.network, p.method, p.url, p.settledAt]
        );
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return false;
        throw err;
      }
    },
    async markProof(nonce, proofTransaction) {
      await client.query(`update ${table} set proof_transaction = $2 where nonce = $1`, [nonce, proofTransaction]);
    },
    async pendingProofs() {
      const { rows } = await client.query(`select * from ${table} where proof_transaction is null order by settled_at`);
      return rows.map(fromRow);
    },
  };
}
