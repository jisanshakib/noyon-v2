// src/bsc.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 2: Chain Layer — BSC RPC reads & calldata building (chainId: 56)
//
// All on-chain READS use ethers.js directly (read-only, no signing needed).
// All on-chain WRITES are built here as calldata and executed in executor.ts
// via wallet.ts → executeContractCall() → baw contract-call.
//
// Contracts:
//   MINT_CONTRACT  = 0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D
//   AI_TOKEN       = 0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924F
//   WBNB           = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
//   PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E
//   REFERRER       = 0x85377229b28515432cCF1e1c4999BB71C9AdBE11 (noyonislam.ai — NEVER change)
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

// ─── Provider (read-only) ─────────────────────────────────────────────────────

export const provider = new ethers.JsonRpcProvider(config.BSC_RPC_URL, {
  chainId: 56,
  name: 'bnb',
});

// ─── Addresses ───────────────────────────────────────────────────────────────

export const ADDR = {
  MINT_CONTRACT:  '0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D',
  AI_TOKEN:       '0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924F',
  WBNB:           '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  PANCAKE_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  REFERRER:       '0x85377229b28515432cCF1e1c4999BB71C9AdBE11', // noyonislam.ai — NEVER change
} as const;

export const REFERRER_NAME = 'noyonislam.ai' as const;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const MINT_ABI = [
  'function costOf(uint256 shares) external view returns (uint256)',
  'function totalMinted() external view returns (uint256)',
  'function mint(uint256 shares, address referrer, uint256 maxCost, uint256 expectedStart, uint256 minTokens, uint256 deadline) external payable returns (uint256)',
  'function developerModeEnabled(address user) external view returns (bool)',
  'function mintQuotaRemaining(address user) external view returns (uint256)',
  'function spaceIdAiName(address user) external view returns (string)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

const ROUTER_ABI = [
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)',
];

// ─── Read-only contract interfaces ───────────────────────────────────────────

const mintIface  = new ethers.Interface(MINT_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const routerIface = new ethers.Interface(ROUTER_ABI);

function mintContract()   { return new ethers.Contract(ADDR.MINT_CONTRACT,  MINT_ABI,   provider); }
function aiTokenContract() { return new ethers.Contract(ADDR.AI_TOKEN,       ERC20_ABI,  provider); }
function routerContract() { return new ethers.Contract(ADDR.PANCAKE_ROUTER,  ROUTER_ABI, provider); }

// ─── On-chain READS ───────────────────────────────────────────────────────────

export async function readCostOf(shares = 10n): Promise<bigint> {
  return BigInt(await mintContract().costOf(shares));
}

export async function readTotalMinted(): Promise<bigint> {
  return BigInt(await mintContract().totalMinted());
}

export async function readAiBalance(address: string): Promise<bigint> {
  return BigInt(await aiTokenContract().balanceOf(address));
}

export async function readBnbBalance(address: string): Promise<bigint> {
  return await provider.getBalance(address);
}

export type OnChainReadResult<T> =
  | { available: true; value: T }
  | { available: false; error: string };

export async function readDeveloperMode(address: string): Promise<OnChainReadResult<boolean>> {
  try {
    const raw = await mintContract().developerModeEnabled(address);
    return { available: true, value: Boolean(raw) };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.debug(
      { walletAddress: address, contract: ADDR.MINT_CONTRACT, fn: 'developerModeEnabled(address)', err: msg },
      'readDeveloperMode on-chain call unavailable (Developer Mode is managed in Binance Agentic Wallet settings)',
    );
    return { available: false, error: msg };
  }
}

export async function readMintQuota(address: string): Promise<OnChainReadResult<bigint>> {
  try {
    const raw = await mintContract().mintQuotaRemaining(address);
    return { available: true, value: BigInt(raw) };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.debug(
      { walletAddress: address, contract: ADDR.MINT_CONTRACT, fn: 'mintQuotaRemaining(address)', err: msg },
      'readMintQuota on-chain call unavailable (quota is checked via Binance Agentic Wallet settings)',
    );
    return { available: false, error: msg };
  }
}

export async function readSpaceIdName(address: string): Promise<string> {
  try {
    const name = String(await mintContract().spaceIdAiName(address) ?? '').trim();
    return name;
  } catch (err) {
    logger.warn(
      { walletAddress: address, err: (err as Error)?.message ?? String(err) },
      'readSpaceIdName on-chain lookup returned error (will allow session/DB/baw fallback)',
    );
    return '';
  }
}

/** True when the candidate is a non-empty *.ai SPACE ID Agent name (e.g. dadyjisan.ai). */
export function isValidAiAgentId(name?: string | null): boolean {
  if (typeof name !== 'string') return false;
  return /^[^\s]+\.ai$/i.test(name.trim());
}

// ─── Sell simulation ──────────────────────────────────────────────────────────

/**
 * Simulates the AI → BNB sell and returns expected BNB output.
 *
 * Uses getAmountsOut + 15% fee discount because the AI token charges a
 * transfer fee that getAmountsOut cannot see (it queries the pool reserve
 * ratio but not the token's own fee). The 15% discount keeps our simulated
 * output below real proceeds so the 8% stop-loss check is conservative.
 */
export async function simulateSellOutput(aiAmount: bigint): Promise<bigint> {
  if (aiAmount === 0n) return 0n;
  try {
    const router = routerContract();
    const amounts: bigint[] = await router.getAmountsOut(aiAmount, [ADDR.AI_TOKEN, ADDR.WBNB]);
    const nominal    = BigInt(amounts[1]);
    const discounted = (nominal * 85n) / 100n; // 15% conservative discount for AI transfer fee
    logger.debug({ nominal: nominal.toString(), discounted: discounted.toString() }, 'simulateSellOutput');
    return discounted;
  } catch (e) {
    logger.warn({ err: e }, 'simulateSellOutput failed — returning 0');
    return 0n;
  }
}

// ─── Preflight checks ─────────────────────────────────────────────────────────

export interface PreflightBawSettings {
  devModeEnabled: boolean | null;
  devModeExpiresAt: string | null;
  devModeExpired: boolean;
  devModeDailyLimit: number;
  devModeQuotaUsed: number | null;
  devModeBalanceExceeded: boolean;
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  rawDevMode?: unknown;
}

export interface PreflightContext {
  sessionAgentId?: string | null;
  dbAgentId?: string | null;
  bawAgentId?: string | null;
  bawSettings?: PreflightBawSettings | null;
  bawSettingsError?: string | null;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  resolvedAgentId?: string;
}

/** Minimum BNB recommended (~0.08 BNB covers mint cost + gas buffer) */
const GAS_BUFFER = ethers.parseEther('0.01');
const MIN_BNB    = ethers.parseEther('0.08');

export async function runPreflightChecks(
  walletAddress: string,
  mintCostWei: bigint,
  ctx?: PreflightContext,
): Promise<PreflightResult> {
  const [bnbBal, onChainSpaceId, onChainDevMode, onChainQuota] = await Promise.all([
    readBnbBalance(walletAddress),
    readSpaceIdName(walletAddress),
    readDeveloperMode(walletAddress),
    readMintQuota(walletAddress),
  ]);

  const onChainName = onChainSpaceId.trim();
  const bawName     = ctx?.bawAgentId?.trim() ?? '';
  const sessionName = ctx?.sessionAgentId?.trim() ?? '';
  const dbName      = ctx?.dbAgentId?.trim() ?? '';

  // Resolve *.ai Agent ID:
  // 1. On-chain readSpaceIdName (if valid *.ai)
  // 2. Live baw wallet agent-id lookup (if valid *.ai)
  // 3. In-memory bound session agentIdName (if valid *.ai)
  // 4. Persisted Supabase users.agent_id_name (if valid *.ai)
  let resolvedAgentId = '';
  let agentIdSource: 'onchain' | 'baw' | 'session' | 'db' | 'none' = 'none';

  if (isValidAiAgentId(onChainName)) {
    resolvedAgentId = onChainName;
    agentIdSource   = 'onchain';
  } else if (isValidAiAgentId(bawName)) {
    resolvedAgentId = bawName;
    agentIdSource   = 'baw';
  } else if (isValidAiAgentId(sessionName)) {
    resolvedAgentId = sessionName;
    agentIdSource   = 'session';
  } else if (isValidAiAgentId(dbName)) {
    resolvedAgentId = dbName;
    agentIdSource   = 'db';
  }

  // Evaluate Developer Mode:
  // Developer Mode is an off-chain Binance Agentic Wallet setting (`baw wallet settings --json`),
  // NOT a Solidity method on the BSC mint contract. Check `bawSettings` first; fall back to
  // on-chain `developerModeEnabled(address)` only if that view call actually exists on-chain.
  const bawSettings = ctx?.bawSettings ?? null;
  let devModeSource: 'baw_settings' | 'onchain' | 'unavailable' = 'unavailable';
  let devModeEnabled: boolean | null = null;

  if (bawSettings && bawSettings.devModeEnabled !== null) {
    devModeSource  = 'baw_settings';
    devModeEnabled = bawSettings.devModeEnabled && !bawSettings.devModeExpired;
  } else if (onChainDevMode.available) {
    devModeSource  = 'onchain';
    devModeEnabled = onChainDevMode.value;
  }

  logger.info(
    {
      walletAddress,
      onChainSpaceId: onChainName || null,
      bawAgentId: bawName || null,
      sessionAgentId: sessionName || null,
      dbAgentId: dbName || null,
      resolvedAgentId: resolvedAgentId || null,
      agentIdSource,
      bnbBalance: ethers.formatEther(bnbBal),
      devModeCheck: {
        source: devModeSource,
        evaluatedEnabled: devModeEnabled,
        bawRawDevMode: bawSettings?.rawDevMode ?? null,
        bawDevModeExpired: bawSettings?.devModeExpired ?? false,
        bawDevModeBalanceExceeded: bawSettings?.devModeBalanceExceeded ?? false,
        bawSettingsError: ctx?.bawSettingsError ?? null,
        onChainAvailable: onChainDevMode.available,
        onChainValue: onChainDevMode.available ? onChainDevMode.value : null,
      },
      quotaCheck: {
        bawDevModeDailyLimit: bawSettings?.devModeDailyLimit ?? null,
        bawDevModeQuotaUsed: bawSettings?.devModeQuotaUsed ?? null,
        bawDailyLimit: bawSettings?.dailyLimit ?? null,
        bawQuotaLeft: bawSettings?.quotaLeft ?? null,
        onChainAvailable: onChainQuota.available,
        onChainValue: onChainQuota.available ? onChainQuota.value.toString() : null,
      },
    },
    'Preflight Agent ID, Developer Mode & chain state check',
  );

  const boundCandidate = bawName || sessionName || dbName;
  if (
    onChainName &&
    boundCandidate &&
    onChainName.toLowerCase() !== boundCandidate.toLowerCase()
  ) {
    logger.warn(
      { walletAddress, onChainSpaceId: onChainName, boundAgentId: boundCandidate, resolvedAgentId },
      'Preflight: on-chain spaceIdAiName differs from bound/session Agent ID',
    );
  }

  const needed = mintCostWei + GAS_BUFFER;
  if (bnbBal < needed) {
    return {
      ok: false,
      resolvedAgentId: resolvedAgentId || undefined,
      reason:
        `Insufficient BNB. Need ≥ ${ethers.formatEther(needed)} BNB (have ${ethers.formatEther(bnbBal)} BNB). ` +
        `Minimum recommended: ${ethers.formatEther(MIN_BNB)} BNB.`,
    };
  }
  if (!resolvedAgentId) {
    return {
      ok: false,
      reason: 'No SPACE ID AI name (*.ai) on this wallet. Register one in the SPACE ID AI dashboard first.',
    };
  }

  if (devModeSource === 'baw_settings' && bawSettings) {
    if (bawSettings.devModeEnabled === false) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          'Developer mode is not enabled in your Binance Agentic Wallet. ' +
          'Enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
    if (bawSettings.devModeExpired) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          `Developer mode expired (${bawSettings.devModeExpiresAt ?? 'past expiry'}). ` +
          'Re-enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
    if (bawSettings.devModeBalanceExceeded) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          'Developer mode balance limit is exceeded in your Binance Agentic Wallet settings. ' +
          'Review your Developer Mode settings in the Binance App.',
      };
    }
  } else if (devModeSource === 'onchain') {
    if (!devModeEnabled) {
      return {
        ok: false,
        resolvedAgentId,
        reason: 'Developer mode is not enabled. Enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
  } else {
    // Neither baw settings nor on-chain read could confirm Developer Mode state.
    return {
      ok: false,
      resolvedAgentId,
      reason:
        `Could not verify Developer Mode status from Binance Agentic Wallet` +
        (ctx?.bawSettingsError ? ` (${ctx.bawSettingsError.slice(0, 120)})` : '') +
        '. Ensure Developer Mode is enabled in Binance App → Agentic Wallet → Settings → Developer Mode and try again.',
    };
  }

  // Quota check:
  // 1. Binance Agentic Wallet Developer Mode daily USD quota
  if (
    bawSettings &&
    bawSettings.devModeDailyLimit > 0 &&
    bawSettings.devModeQuotaUsed != null &&
    bawSettings.devModeQuotaUsed >= bawSettings.devModeDailyLimit
  ) {
    return {
      ok: false,
      resolvedAgentId,
      reason:
        `Developer Mode daily quota exhausted ($${bawSettings.devModeQuotaUsed.toFixed(2)} / $${bawSettings.devModeDailyLimit.toFixed(2)}). ` +
        'Increase your Developer Mode daily limit in the Binance App or wait for daily reset.',
    };
  }
  // 2. General daily trading limit from baw settings
  if (bawSettings && bawSettings.dailyLimit > 0 && bawSettings.quotaLeft <= 0) {
    return {
      ok: false,
      resolvedAgentId,
      reason: 'Daily trading quota exhausted in Binance Agentic Wallet. Wait for daily quota reset.',
    };
  }
  // 3. On-chain mintQuotaRemaining (only enforced when the contract actually exposes this view method)
  if (onChainQuota.available && onChainQuota.value === 0n) {
    return {
      ok: false,
      resolvedAgentId,
      reason: 'Mint quota exhausted. Wait for daily quota reset.',
    };
  }

  return { ok: true, resolvedAgentId };
}

// ─── Calldata builders (for baw contract-call) ────────────────────────────────

/**
 * Returns live mint parameters + 0x calldata ready for baw contract-call.
 * Re-reads totalMinted() and costOf() on every call so expectedStart is fresh.
 */
export async function buildMintCalldata(shares = 10n): Promise<{
  inputData: string;
  value: bigint;      // wei — tx value = maxCost (pays for mint)
  maxCost: bigint;
  expectedStart: bigint;
}> {
  const [maxCost, totalMintedNow] = await Promise.all([
    readCostOf(shares),
    readTotalMinted(),
  ]);
  const expectedStart = totalMintedNow + 1n;
  const deadline      = BigInt(Math.floor(Date.now() / 1000) + 600);

  const inputData = mintIface.encodeFunctionData('mint', [
    shares,
    ADDR.REFERRER,  // noyonislam.ai — never change
    maxCost,
    expectedStart,
    0n,             // minTokens
    deadline,
  ]);

  logger.debug({ maxCost: maxCost.toString(), expectedStart: expectedStart.toString() }, 'buildMintCalldata');
  return { inputData, value: maxCost, maxCost, expectedStart };
}

/**
 * Returns approve calldata for exact AI token amount to PancakeSwap Router.
 * No over-approval — amount is the exact tokensReceived from mint.
 */
export function buildApproveCalldata(amount: bigint): string {
  return erc20Iface.encodeFunctionData('approve', [ADDR.PANCAKE_ROUTER, amount]);
}

/**
 * Returns swapExactTokensForETHSupportingFeeOnTransferTokens calldata.
 * amountOutMin = 0 — stop-loss check enforced upstream by executor.
 */
export function buildSellCalldata(aiAmount: bigint, walletAddress: string): string {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return routerIface.encodeFunctionData(
    'swapExactTokensForETHSupportingFeeOnTransferTokens',
    [aiAmount, 0n, [ADDR.AI_TOKEN, ADDR.WBNB], walletAddress, deadline],
  );
}

/** Checks if a revert error is a mint race (expectedStart mismatch: 0x5fb01790) */
export function isMintRaceError(err: unknown): boolean {
  const e = err as { data?: string; message?: string } | null;
  return !!(
    e?.data?.includes('5fb01790') ||
    e?.message?.includes('5fb01790') ||
    e?.message?.toLowerCase().includes('expectedstart')
  );
}

export interface RpcSimulationResult {
  ok: boolean;
  estimatedGas?: bigint;
  isRevert?: boolean;
  revertData?: string;
  revertReason?: string;
  error?: string;
}

/**
 * Runs a read-only BSC RPC `eth_estimateGas` simulation before calling `baw`.
 * Surfaces real contract reverts (e.g. 0x5fb01790 expectedStart race or custom errors)
 * and provides an on-chain gas estimate for diagnostics and buffered retry if needed.
 */
export async function simulateContractCall(opts: {
  step: string;
  from: string;
  to: string;
  data: string;
  value?: bigint;
}): Promise<RpcSimulationResult> {
  const { step, from, to, data, value = 0n } = opts;
  const fnSelector = data.slice(0, 10);

  try {
    const estimatedGas = await provider.estimateGas({ from, to, data, value });
    logger.info(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        estimatedGas: estimatedGas.toString(),
      },
      'BSC RPC estimateGas succeeded',
    );
    return { ok: true, estimatedGas };
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      data?: string;
      reason?: string;
      shortMessage?: string;
      message?: string;
      info?: { error?: { data?: string; message?: string } };
    };
    const revertData =
      typeof e?.data === 'string' && e.data.startsWith('0x') && e.data.length > 2
        ? e.data
        : typeof e?.info?.error?.data === 'string' && e.info.error.data.startsWith('0x') && e.info.error.data.length > 2
          ? e.info.error.data
          : undefined;
    const rawMsg = e?.shortMessage ?? e?.message ?? String(err);
    const revertReason =
      e?.reason ??
      e?.info?.error?.message ??
      (revertData ? `custom error ${revertData.slice(0, 10)}` : undefined);

    const isRevert = Boolean(
      e?.code === 'CALL_EXCEPTION' ||
      revertData ||
      /revert|execution reverted|invalid opcode/i.test(rawMsg),
    );

    logger.warn(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        code: e?.code ?? null,
        isRevert,
        revertData: revertData ? revertData.slice(0, 74) : null,
        revertReason: revertReason ?? null,
        error: rawMsg.slice(0, 240),
      },
      'BSC RPC estimateGas failed',
    );

    return {
      ok: false,
      isRevert,
      revertData,
      revertReason,
      error: rawMsg,
    };
  }
}

/** Returns gasPrice for LOW/MEDIUM priority (+5% above base) */
export async function getLowGasPrice(): Promise<bigint> {
  const feeData = await provider.getFeeData();
  const base = feeData.gasPrice != null ? BigInt(feeData.gasPrice) : ethers.parseUnits('3', 'gwei');
  return (base * 105n) / 100n;
}
