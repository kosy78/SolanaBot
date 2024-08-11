import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  cacheTTL: number;
  minSlippage: number;
  maxSlippage: number;
  volatilityWindow: number;
  strategy: 'momentum' | 'meanReversion';
}

interface CachedPoolInfo {
  info: Awaited<ReturnType<typeof Liquidity.fetchInfo>>;
  timestamp: number;
}

interface PriceHistory {
  prices: number[];
  lastUpdateTimestamp: number;
}

interface TradingStrategy {
  shouldBuy(priceHistory: PriceHistory): boolean;
  shouldSell(priceHistory: PriceHistory): boolean;
}

class MomentumStrategy implements TradingStrategy {
  constructor(private readonly lookbackPeriod: number = 5) {}

  shouldBuy(priceHistory: PriceHistory): boolean {
    if (priceHistory.prices.length < this.lookbackPeriod) return false;
    const recentPrices = priceHistory.prices.slice(-this.lookbackPeriod);
    return recentPrices.every((price, index) => index === 0 || price > recentPrices[index - 1]);
  }

  shouldSell(priceHistory: PriceHistory): boolean {
    if (priceHistory.prices.length < this.lookbackPeriod) return false;
    const recentPrices = priceHistory.prices.slice(-this.lookbackPeriod);
    return recentPrices.every((price, index) => index === 0 || price < recentPrices[index - 1]);
  }
}

class MeanReversionStrategy implements TradingStrategy {
  constructor(private readonly lookbackPeriod: number = 20, private readonly threshold: number = 0.1) {}

  shouldBuy(priceHistory: PriceHistory): boolean {
    if (priceHistory.prices.length < this.lookbackPeriod) return false;
    const recentPrices = priceHistory.prices.slice(-this.lookbackPeriod);
    const mean = recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length;
    const currentPrice = recentPrices[recentPrices.length - 1];
    return (mean - currentPrice) / mean > this.threshold;
  }

  shouldSell(priceHistory: PriceHistory): boolean {
    if (priceHistory.prices.length < this.lookbackPeriod) return false;
    const recentPrices = priceHistory.prices.slice(-this.lookbackPeriod);
    const mean = recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length;
    const currentPrice = recentPrices[recentPrices.length - 1];
    return (currentPrice - mean) / mean > this.threshold;
  }
}

export class Bot {
  private readonly poolFilters: PoolFilters;
  private readonly snipeListCache?: SnipeListCache;
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private poolInfoCache: Map<string, CachedPoolInfo> = new Map();
  private priceHistoryCache: Map<string, PriceHistory> = new Map();
  private strategy: TradingStrategy;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }

    this.strategy = this.config.strategy === 'momentum' ? new MomentumStrategy() : new MeanReversionStrategy();
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.info({ mint: poolState.baseMint }, `Processing new pool for buying...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.debug({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      const priceHistory = await this.updatePriceHistory(poolKeys);
      if (!this.strategy.shouldBuy(priceHistory)) {
        logger.debug({ mint: poolKeys.baseMint.toString() }, `Skipping buy based on trading strategy decision`);
        return;
      }

      const dynamicSlippage = await this.calculateDynamicSlippage(poolKeys, 'buy');

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            dynamicSlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            break;
          }

          logger.warn(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx, retrying...`,
          );
        } catch (error) {
          logger.error({ mint: poolState.baseMint.toString(), error }, `Error executing buy transaction`);
          if (i === this.config.maxBuyRetries - 1) {
            logger.error({ mint: poolState.baseMint.toString() }, `Max buy retries reached, giving up`);
          }
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.info({ mint: rawAccount.mint }, `Processing new token for selling...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.warn({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.warn({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      const priceHistory = await this.updatePriceHistory(poolKeys);
      if (!this.strategy.shouldSell(priceHistory)) {
        logger.debug({ mint: poolKeys.baseMint.toString() }, `Skipping sell based on trading strategy decision`);
        return;
      }

      const dynamicSlippage = await this.calculateDynamicSlippage(poolKeys, 'sell');

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            dynamicSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.warn(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx, retrying...`,
          );
        } catch (error) {
          logger.error({ mint: rawAccount.mint.toString(), error }, `Error executing sell transaction`);
          if (i === this.config.maxSellRetries - 1) {
            logger.error({ mint: rawAccount.mint.toString() }, `Max sell retries reached, giving up`);
          }
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    let poolInfo;
    try {
      poolInfo = await this.getCachedPoolInfo(poolKeys);
    } catch (error) {
      logger.error({ error }, `Failed to fetch pool info`);
      throw error;
    }

    let computedAmountOut;
    try {
      computedAmountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn,
        currencyOut: tokenOut,
        slippage: slippagePercent,
      });
    } catch (error) {
      logger.error({ error }, `Failed to compute amount out`);
      throw error;
    }

    let latestBlockhash;
    try {
      latestBlockhash = await this.connection.getLatestBlockhash();
    } catch (error) {
      logger.error({ error }, `Failed to get latest blockhash`);
      throw error;
    }

    let innerTransaction;
    try {
      innerTransaction = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: poolKeys,
          userKeys: {
            tokenAccountIn: ataIn,
            tokenAccountOut: ataOut,
            owner: wallet.publicKey,
          },
          amountIn: amountIn.raw,
          minAmountOut: computedAmountOut.minAmountOut.raw,
        },
        poolKeys.version,
      );
    } catch (error) {
      logger.error({ error }, `Failed to create swap instruction`);
      throw error;
    }

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async getCachedPoolInfo(poolKeys: LiquidityPoolKeysV4) {
    const cacheKey = poolKeys.id.toString();
    const cachedInfo = this.poolInfoCache.get(cacheKey);
    const now = Date.now();

    if (cachedInfo && now - cachedInfo.timestamp < this.config.cacheTTL) {
      return cachedInfo.info;
    }

    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    this.poolInfoCache.set(cacheKey, { info: poolInfo, timestamp: now });
    return poolInfo;
  }

  private async updatePriceHistory(poolKeys: LiquidityPoolKeysV4): Promise<PriceHistory> {
    const cacheKey = poolKeys.id.toString();
    const now = Date.now();
    let priceHistory = this.priceHistoryCache.get(cacheKey);

    if (!priceHistory || now - priceHistory.lastUpdateTimestamp > this.config.volatilityWindow) {
      priceHistory = { prices: [], lastUpdateTimestamp: now };
    }

    const poolInfo = await this.getCachedPoolInfo(poolKeys);
    const currentPrice = poolInfo.sqrtPriceX64.toNumber() / Math.pow(2, 64);

    priceHistory.prices.push(currentPrice);
    if (priceHistory.prices.length > 20) {
      priceHistory.prices.shift();
    }

    this.priceHistoryCache.set(cacheKey, {
      prices: priceHistory.prices,
      lastUpdateTimestamp: now,
    });

    return priceHistory;
  }

  private async calculateDynamicSlippage(poolKeys: LiquidityPoolKeysV4, direction: 'buy' | 'sell'): Promise<number> {
    const priceHistory = await this.updatePriceHistory(poolKeys);

    if (priceHistory.prices.length < 2) {
      return direction === 'buy' ? this.config.buySlippage : this.config.sellSlippage;
    }

    const priceChanges = priceHistory.prices.slice(1).map((price, index) => {
      const prevPrice = priceHistory.prices[index];
      return Math.abs((price - prevPrice) / prevPrice);
    });

    const averageVolatility = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    const volatilityFactor = Math.min(Math.max(averageVolatility * 100, 1), 5);

    const baseSlippage = direction === 'buy' ? this.config.buySlippage : this.config.sellSlippage;
    const dynamicSlippage = baseSlippage * volatilityFactor;

    return Math.min(Math.max(dynamicSlippage, this.config.minSlippage), this.config.maxSlippage);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), error }, `Error during filter match`);
        return false;
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await this.getCachedPoolInfo(poolKeys);

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          logger.info({ mint: poolKeys.baseMint.toString() }, `Stop loss triggered`);
          break;
        }

        if (amountOut.gt(takeProfit)) {
          logger.info({ mint: poolKeys.baseMint.toString() }, `Take profit triggered`);
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), error }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }
}
