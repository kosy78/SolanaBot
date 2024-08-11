import { Bot, BotConfig } from './bot';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache } from './cache';
import { TransactionExecutor } from './transactions';
import BN from 'bn.js';

interface TradeResult {
  action: 'buy' | 'sell';
  price: number;
  amount: number;
  timestamp: number;
}

export class Backtester {
  private bot: Bot;
  private historicalData: { price: number; timestamp: number }[];

  constructor(
    private connection: Connection,
    private marketStorage: MarketCache,
    private poolStorage: PoolCache,
    private txExecutor: TransactionExecutor,
    private config: BotConfig,
    historicalData: { price: number; timestamp: number }[]
  ) {
    this.bot = new Bot(connection, marketStorage, poolStorage, txExecutor, config);
    this.historicalData = historicalData;
  }

  async runBacktest(): Promise<{
    trades: TradeResult[];
    finalBalance: number;
    totalProfit: number;
    winRate: number;
  }> {
    let balance = this.config.quoteAmount.toNumber();
    let tokenBalance = 0;
    const trades: TradeResult[] = [];
    let winningTrades = 0;
    let totalTrades = 0;

    for (let i = 0; i < this.historicalData.length; i++) {
      const currentPrice = this.historicalData[i].price;
      const currentTimestamp = this.historicalData[i].timestamp;

      // Simulate price history
      const priceHistory = this.historicalData.slice(Math.max(0, i - 20), i + 1).map(d => d.price);
      const mockPriceHistory = {
        prices: priceHistory,
        lastUpdateTimestamp: currentTimestamp,
      };

      if (tokenBalance === 0) {
        // Check if we should buy
        if (this.bot.getStrategy().shouldBuy(mockPriceHistory)) {
          const buyAmount = balance / currentPrice;
          balance = 0;
          tokenBalance = buyAmount;
          trades.push({
            action: 'buy',
            price: currentPrice,
            amount: buyAmount,
            timestamp: currentTimestamp,
          });
          totalTrades++;
        }
      } else {
        // Check if we should sell
        if (this.bot.getStrategy().shouldSell(mockPriceHistory)) {
          const sellAmount = tokenBalance * currentPrice;
          balance = sellAmount;
          tokenBalance = 0;
          trades.push({
            action: 'sell',
            price: currentPrice,
            amount: sellAmount,
            timestamp: currentTimestamp,
          });
          totalTrades++;

          // Check if this trade was profitable
          if (trades[trades.length - 1].price > trades[trades.length - 2].price) {
            winningTrades++;
          }
        }
      }
    }

    // Sell any remaining tokens at the last price
    if (tokenBalance > 0) {
      const lastPrice = this.historicalData[this.historicalData.length - 1].price;
      const sellAmount = tokenBalance * lastPrice;
      balance = sellAmount;
      trades.push({
        action: 'sell',
        price: lastPrice,
        amount: sellAmount,
        timestamp: this.historicalData[this.historicalData.length - 1].timestamp,
      });
    }

    const initialBalance = this.config.quoteAmount.toNumber();
    const finalBalance = balance;
    const totalProfit = finalBalance - initialBalance;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    return {
      trades,
      finalBalance,
      totalProfit,
      winRate,
    };
  }
}

// Example usage:
// const connection = new Connection('https://api.mainnet-beta.solana.com');
// const marketStorage = new MarketCache();
// const poolStorage = new PoolCache();
// const txExecutor = new DefaultTransactionExecutor(connection);
// const wallet = Keypair.generate();
// const config: BotConfig = {
//   wallet,
//   quoteToken: new Token(TOKEN_PROGRAM_ID, new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 6),
//   quoteAmount: new TokenAmount(new Token(TOKEN_PROGRAM_ID, new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 6), new BN(1000000000)),
//   strategy: 'momentum',
//   // ... other configuration options
// };
// const historicalData = [
//   { price: 1.0, timestamp: 1625097600000 },
//   { price: 1.1, timestamp: 1625184000000 },
//   // ... more historical data
// ];
// const backtester = new Backtester(connection, marketStorage, poolStorage, txExecutor, config, historicalData);
// backtester.runBacktest().then(result => console.log(result));