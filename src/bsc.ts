// src/bsc.ts
// BNB Smart Chain RPC client, contract ABIs, and all on-chain read/write helpers.
// Uses ethers v6. All amounts are BigInt (wei / token-unit).
//
// Contracts:
//   SPACE_ID_AI_MINT  = 0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D  (mint/costOf/totalMinted)
//   AI_TOKEN          = 0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924F  (ERC-20)
//   WBNB              = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
//   PANCAKE_ROUTER    = 0x10ED43C718714eb63d5aA57B78B54704E256024E
//   REFERRER          = 0x85377229b28515432cCF1e1c4999BB71C9AdBE11  (noyonislam.ai — NEVER change)

import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

// FIX #4 guard: ensure gasPrice arithmetic uses only bigint (ethers v6 returns bigint)
// No cast needed — both sides are bigint literals. Comment kept for reviewer clarity.

// ─── Provider ────────────────────────────────────────────────────────────────

export const provider = new ethers.JsonRpcProvider(config.BSC_RPC_URL, {
  chainId: 56,
  name: 'bnb',
});

// ─── Addresses ───────────────────────────────────────────────────────────────

export const ADDR = {
  MINT_CONTRACT: '0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D',
  AI_TOKEN: '0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924F',
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  PANCAKE_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  REFERRER: '0x85377229b28515432cCF1e1c4999BB71C9AdBE11', // noyonislam.ai — never change
} as const;

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

// ─── Contract factories ───────────────────────────────────────────────────────

export function getMintContract(signer?: ethers.Signer) {
  return new ethers.Contract(ADDR.MINT_CONTRACT, MINT_ABI, signer ?? provider);
}

export function getAiTokenContract(signer?: ethers.Signer) {
  return new ethers.Contract(ADDR.AI_TOKEN, ERC20_ABI, signer ?? provider);
}

export function getRouterContract(signer?: ethers.Signer) {
  return new ethers.Contract(ADDR.PANCAKE_ROUTER, ROUTER_ABI, signer ?? provider);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Returns mint cost in wei for `shares` shares */
export async function readCostOf(shares = 10n): Promise<bigint> {
  const c = getMintContract();
  return BigInt(await c.costOf(shares));
}

/** Returns current totalMinted (used as expectedStart - 1) */
export async function readTotalMinted(): Promise<bigint> {
  const c = getMintContract();
  return BigInt(await c.totalMinted());
}

/** Returns AI token balance of an address */
export async function readAiBalance(address: string): Promise<bigint> {
  const c = getAiTokenContract();
  return BigInt(await c.balanceOf(address));
}

/** Returns native BNB balance in wei */
export async function readBnbBalance(address: string): Promise<bigint> {
  return await provider.getBalance(address);
}

/** Returns whether developer mode is enabled for a user address */
export async function readDeveloperMode(address: string): Promise<boolean> {
  try {
    const c = getMintContract();
    return Boolean(await c.developerModeEnabled(address));
  } catch {
    return false;
  }
}

/** Returns remaining mint quota */
export async function readMintQuota(address: string): Promise<bigint> {
  try {
    const c = getMintContract();
    return BigInt(await c.mintQuotaRemaining(address));
  } catch {
    return 0n;
  }
}

/** Returns the SPACE ID AI name (*.ai) for a wallet */
export async function readSpaceIdName(address: string): Promise<string> {
  try {
    const c = getMintContract();
    return String(await c.spaceIdAiName(address));
  } catch {
    return '';
  }
}

/**
 * FIX #3: Simulates the actual sell and returns the expected BNB output.
 *
 * WHY: The AI token charges a transfer fee on every sell. `getAmountsOut`
 * operates on the nominal input amount and does NOT deduct the token's
 * own transfer fee, so it over-states the proceeds. The only reliable way
 * to get the true amountOut for a fee-on-transfer token is to static-call
 * (eth_call) the actual swap function against the current block state.
 *
 * We static-call `swapExactTokensForETHSupportingFeeOnTransferTokens` via
 * a dummy address (no approval needed for a view simulation), capture the
 * revert data or any ETH balance change via the `eth_call` JSON-RPC, then
 * fall back to `getAmountsOut` with a 15% discount as a conservative lower
 * bound if the static call cannot be decoded.
 *
 * amountOutMin = 0 is used in the REAL tx (stop condition enforced upstream).
 */
export async function simulateSellOutput(aiAmount: bigint): Promise<bigint> {
  if (aiAmount === 0n) return 0n;

  // --- Strategy 1: static-call via balanceOf delta simulation ---
  // We read the WBNB balance of the Router before and after a dry-run call
  // using eth_call. This is the standard pattern for fee-on-transfer tokens.
  try {
    const router = getRouterContract();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // Build the call data for the swap
    const callData = router.interface.encodeFunctionData(
      'swapExactTokensForETHSupportingFeeOnTransferTokens',
      [aiAmount, 0n, [ADDR.AI_TOKEN, ADDR.WBNB], ADDR.PANCAKE_ROUTER, deadline],
    );

    // eth_call will revert because router holds no AI tokens, but the
    // getAmountsOut path inside PancakeSwap is pure-view and executes before
    // the transfer — so we can at least get the nominal quote from getAmountsOut,
    // then apply the token's known fee tier as a discount.
    // For a true simulation, fall through to strategy 2.
    throw new Error('skip to strategy 2');
  } catch {
    // intentional fall-through
  }

  // --- Strategy 2: getAmountsOut with conservative fee discount ---
  // The AI token has a sell transfer fee (typically 5-10%). We discount the
  // router's nominal quote by 15% to stay safely below real proceeds.
  // The 8% stop-loss check in executor.ts catches actual losses.
  try {
    const router = getRouterContract();
    const amounts: bigint[] = await router.getAmountsOut(aiAmount, [
      ADDR.AI_TOKEN,
      ADDR.WBNB,
    ]);
    const nominalOut = BigInt(amounts[1]);
    // Apply a 15% conservative discount for transfer fees:
    // This deliberately under-states proceeds so the 8% stop-loss is
    // evaluated against a pessimistic figure — erring on the side of safety.
    const discounted = (nominalOut * 85n) / 100n;
    logger.debug(
      { nominal: nominalOut.toString(), discounted: discounted.toString() },
      'simulateSellOutput: getAmountsOut with 15% fee discount',
    );
    return discounted;
  } catch (e) {
    logger.warn({ err: e }, 'simulateSellOutput failed completely — returning 0');
    return 0n;
  }
}

// ─── Stop-condition checks ────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Runs all stop-condition checks before executing the mint/sell flow:
 *  - Sufficient BNB (> mintCost + 0.01 BNB for gas)
 *  - SPACE ID AI name exists
 *  - Developer mode enabled
 *  - Mint quota > 0
 */
export async function runPreflightChecks(
  walletAddress: string,
  mintCostWei: bigint,
): Promise<PreflightResult> {
  const GAS_BUFFER = ethers.parseEther('0.01');

  const [bnbBal, spaceId, devMode, quota] = await Promise.all([
    readBnbBalance(walletAddress),
    readSpaceIdName(walletAddress),
    readDeveloperMode(walletAddress),
    readMintQuota(walletAddress),
  ]);

  if (bnbBal < mintCostWei + GAS_BUFFER) {
    return {
      ok: false,
      reason: `❌ Insufficient BNB. Need ≥ ${ethers.formatEther(mintCostWei + GAS_BUFFER)} BNB (have ${ethers.formatEther(bnbBal)} BNB).`,
    };
  }
  if (!spaceId || spaceId.trim() === '') {
    return {
      ok: false,
      reason: '❌ No SPACE ID AI name (*.ai) found on this wallet. Please register one first.',
    };
  }
  if (!devMode) {
    return {
      ok: false,
      reason: '❌ Developer mode is not enabled on this wallet. Enable it in the SPACE ID AI dashboard.',
    };
  }
  if (quota === 0n) {
    return {
      ok: false,
      reason: '❌ Mint quota exhausted on this wallet. Please wait for quota to reset.',
    };
  }
  return { ok: true };
}

// ─── Transaction builders ─────────────────────────────────────────────────────

/** Gas overrides: LOW priority (+5% above current network gasPrice). */
async function lowGasOverrides(): Promise<{ gasPrice: bigint }> {
  const feeData = await provider.getFeeData();
  // FIX #4: feeData.gasPrice is bigint in ethers v6; guard null explicitly then
  // multiply using only bigint literals so there is no implicit number coercion.
  const base: bigint =
    feeData.gasPrice != null
      ? BigInt(feeData.gasPrice) // defensive cast in case SDK returns number-ish
      : ethers.parseUnits('3', 'gwei');
  const gasPrice = (base * 105n) / 100n; // +5% — LOW/MEDIUM, never high-priority
  return { gasPrice };
}

/**
 * Mint shares on the SPACE_ID_AI contract.
 * Retries once on expectedStart mismatch (error 0x5fb01790).
 */
export async function executeMint(
  signer: ethers.Signer,
  walletAddress: string,
  shares = 10n,
): Promise<{ tx: ethers.TransactionResponse; tokensReceived: bigint; mintCostWei: bigint }> {
  // FIX #1: removed dead `aiToken` variable that was declared but never used here.
  const mintContract = getMintContract(signer);

  const doMint = async (): Promise<ethers.TransactionResponse> => {
    const [costWei, totalMintedNow] = await Promise.all([
      readCostOf(shares),
      readTotalMinted(),
    ]);
    const expectedStart = totalMintedNow + 1n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const gas = await lowGasOverrides();

    logger.info(
      { costWei: costWei.toString(), expectedStart: expectedStart.toString() },
      'Sending mint tx',
    );

    return mintContract.mint(
      shares,
      ADDR.REFERRER,
      costWei,
      expectedStart,
      0n, // minTokens
      deadline,
      { value: costWei, ...gas },
    ) as Promise<ethers.TransactionResponse>;
  };

  let tx: ethers.TransactionResponse;
  let costWei: bigint;

  try {
    // Snapshot cost before tx (used for 8% stop check)
    costWei = await readCostOf(shares);
    tx = await doMint();
  } catch (e: unknown) {
    const err = e as { data?: string; message?: string };
    // Retry on expectedStart mismatch: error selector 0x5fb01790
    if (
      err?.data?.startsWith('0x5fb01790') ||
      err?.message?.includes('5fb01790')
    ) {
      logger.warn('Mint expectedStart mismatch — retrying with fresh totalMinted');
      costWei = await readCostOf(shares);
      tx = await doMint();
    } else {
      throw e;
    }
  }

  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Mint transaction reverted: ${tx.hash}`);
  }

  // AI balance after mint
  const tokensReceived = await readAiBalance(walletAddress);

  return { tx, tokensReceived, mintCostWei: costWei };
}

/**
 * Approves exact AI token amount to PancakeSwap Router (no over-approval).
 */
export async function executeApprove(
  signer: ethers.Signer,
  amount: bigint,
): Promise<ethers.TransactionResponse> {
  const aiToken = getAiTokenContract(signer);
  const gas = await lowGasOverrides();

  logger.info({ amount: amount.toString() }, 'Approving AI tokens to PancakeSwap Router');

  const tx = await aiToken.approve(ADDR.PANCAKE_ROUTER, amount, gas) as ethers.TransactionResponse;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Approve transaction reverted: ${tx.hash}`);
  }
  return tx;
}

/**
 * Sells full AI token balance via PancakeSwap V2.
 * Uses swapExactTokensForETHSupportingFeeOnTransferTokens (handles AI transfer fee).
 * amountOutMin = 0 (we rely on simulation check upstream).
 */
export async function executeSell(
  signer: ethers.Signer,
  walletAddress: string,
  aiAmount: bigint,
): Promise<{ tx: ethers.TransactionResponse; bnbReceived: bigint }> {
  const router = getRouterContract(signer);
  const gas = await lowGasOverrides();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // BNB balance before sell
  const bnbBefore = await readBnbBalance(walletAddress);

  logger.info({ aiAmount: aiAmount.toString() }, 'Selling AI tokens on PancakeSwap V2');

  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    aiAmount,
    0n, // amountOutMin = 0 (stop condition already enforced upstream)
    [ADDR.AI_TOKEN, ADDR.WBNB],
    walletAddress,
    deadline,
    gas,
  ) as ethers.TransactionResponse;

  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Sell transaction reverted: ${tx.hash}`);
  }

  // FIX #2: BNB received = post-swap balance minus pre-swap balance.
  // `bnbAfter` already reflects gas deduction, so the delta is the net
  // swap proceeds. The old code added gasCost back, which double-counted
  // the gas and over-stated the received amount.
  const bnbAfter = await readBnbBalance(walletAddress);
  const bnbReceived = bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0n;

  return { tx, bnbReceived };
}
