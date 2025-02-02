import pino from "pino"
import { yamlConfig } from "./config"
import { Result } from "./Result"
import { btc2sat, roundBtc } from "./utils"
import {
  HedgingStrategies,
  HedgingStrategy,
  UpdatedBalance,
  UpdatedPosition,
} from "./HedgingStrategyTypes"
import {
  ExchangeNames,
  FundingFeesMetrics,
  FundingRate,
  FundingYieldMetrics,
  InFlightTransfer,
  TradingFeesMetrics,
  Transaction,
} from "./database/models"
import { db as database } from "./database"

import { GaloyWallet } from "./GaloyWalletTypes"
import { createDealerWallet, WalletType } from "./DealerWalletFactory"
import { createHedgingStrategy } from "./HedgingStrategyFactory"
import {
  FetchFundingAccountBalanceResult,
  GetAccountAndPositionRiskResult,
  GetFundingRateHistoryParameters,
  GetTransactionHistoryParameters,
} from "./ExchangeTradingType"
import {
  addAttributesToCurrentSpan,
  asyncRunInSpan,
  SemanticAttributes,
} from "./services/tracing"

const hedgingBounds = yamlConfig.hedging

export type UpdatedPositionAndLeverageResult = {
  updatePositionSkipped: boolean
  updatedPositionResult: Result<UpdatedPosition>
  updateLeverageSkipped: boolean
  updatedLeverageResult: Result<UpdatedBalance>
}

export interface DerivativeMarketInfoResult {
  bidInUsd: number
  askInUsd: number
}

export class Dealer {
  private wallet: GaloyWallet
  private strategy: HedgingStrategy
  private logger: pino.Logger

  constructor(logger: pino.Logger) {
    const activeStrategy = process.env["ACTIVE_STRATEGY"]
    const walletType = process.env["ACTIVE_WALLET"]

    if (!activeStrategy) {
      throw new Error(`Missing dealer active strategy environment variable`)
    } else if (!walletType) {
      throw new Error(`Missing dealer wallet type environment variable`)
    }

    this.wallet = createDealerWallet(walletType as WalletType, logger)
    this.strategy = createHedgingStrategy(activeStrategy as HedgingStrategies, logger)

    this.logger = logger.child({ topic: "dealer" })
  }

  private async updateInFlightTransfer(): Promise<Result<void>> {
    await asyncRunInSpan(
      "app.dealer.updateInFlightTransfer",
      {
        [SemanticAttributes.CODE_FUNCTION]: "updateInFlightTransfer",
        [SemanticAttributes.CODE_NAMESPACE]: "app.dealer",
      },
      async () => {
        const logger = this.logger.child({ method: "updateInFlightTransfer()" })

        // Check and Update persisted in-flight fund transfer
        let result = await database.inFlightTransfers.getPendingDeposit()
        logger.debug({ result }, "database.getPendingDeposit() returned: {result}")
        if (result.ok && result.value.size !== 0) {
          // Check if the funds arrived
          const transfersMap = result.value

          for (const [address, transfers] of transfersMap) {
            for (const transfer of transfers) {
              const result = await this.strategy.isDepositCompleted(
                address,
                transfer.transferSizeInSats,
              )
              logger.debug(
                { address, transfer, result },
                "strategy.isDepositCompleted({address}, {transferSizeInSats}) returned: {result}",
              )
              if (result.ok && result.value) {
                const result = await database.inFlightTransfers.completed(address)
                logger.debug(
                  { address, result },
                  "database.completedInFlightTransfer({address}) returned: {result}",
                )
                if (!result.ok) {
                  const message =
                    "Failed to update database on completed deposit to exchange"
                  logger.debug({ result, transfer }, message)
                }
              }
            }
          }
        }

        result = await database.inFlightTransfers.getPendingWithdraw()
        logger.debug({ result }, "database.getPendingWithdraw() returned: {result}")
        if (result.ok && result.value.size !== 0) {
          // Check if the funds arrived
          const transfersMap = result.value
          for (const [address, transfers] of transfersMap) {
            for (const transfer of transfers) {
              const result = await this.strategy.isWithdrawalCompleted(
                address,
                transfer.transferSizeInSats,
              )
              logger.debug(
                { address, transfer, result },
                "strategy.isWithdrawalCompleted({address}, {transferSizeInSats}) returned: {result}",
              )
              if (result.ok && result.value) {
                const result = await database.inFlightTransfers.completed(address)
                logger.debug(
                  { address, result },
                  "database.completedInFlightTransfer({address}) returned: {result}",
                )
                if (!result.ok) {
                  const message =
                    "Failed to update database on completed withdrawal from exchange"
                  logger.debug({ result, transfer }, message)
                }
              }
            }
          }
        }
      },
    )
    return { ok: true, value: undefined }
  }

  public async updatePositionAndLeverage(): Promise<
    Result<UpdatedPositionAndLeverageResult>
  > {
    const ret = await asyncRunInSpan(
      "app.dealer.updatePositionAndLeverage",
      {
        [SemanticAttributes.CODE_FUNCTION]: "updatePositionAndLeverage",
        [SemanticAttributes.CODE_NAMESPACE]: "app.dealer",
      },
      async () => {
        const logger = this.logger.child({ method: "updatePositionAndLeverage()" })

        const updateResult = await this.updateInFlightTransfer()
        if (!updateResult.ok) {
          logger.error(
            { error: updateResult.error },
            "Error while updating in-flight fund transfer.",
          )
          return updateResult
        }

        const priceResult = await this.strategy.getBtcSpotPriceInUsd()
        if (!priceResult.ok) {
          logger.error({ error: priceResult.error }, "Cannot get BTC spot price.")
          return { ok: false, error: priceResult.error }
        }
        const btcPriceInUsd = priceResult.value
        const usdLiabilityResult = await this.wallet.getUsdWalletBalance()
        logger.debug(
          { usdLiabilityResult },
          "wallet.getUsdWalletBalance() returned: {usdLiabilityResult}",
        )

        // If liability is negative, treat as an asset and do not hedge
        // If liability is below threshold, do not hedge
        if (!usdLiabilityResult.ok || Number.isNaN(usdLiabilityResult.value)) {
          const message = "Liabilities is unavailable or NaN."
          logger.debug({ usdLiabilityResult }, message)
          return { ok: false, error: new Error(message) }
        }

        // Wallet usd balance is negative if actual liability,
        // return additive inverse to deal with positive liability onward
        const usdLiability = -usdLiabilityResult.value

        addAttributesToCurrentSpan({
          [`${SemanticAttributes.CODE_FUNCTION}.results.usdLiability`]: usdLiability,
          [`${SemanticAttributes.CODE_FUNCTION}.results.btcPriceInUsd`]: btcPriceInUsd,
          [`${SemanticAttributes.CODE_FUNCTION}.results.activeStrategy`]:
            this.strategy.name,
        })

        const result = {} as UpdatedPositionAndLeverageResult

        if (usdLiability < hedgingBounds.MINIMUM_POSITIVE_LIABILITY_USD) {
          logger.debug(
            { usdLiability },
            "No liabilities to hedge, skipping the order loop and closing position if any",
          )

          addAttributesToCurrentSpan({
            [`${SemanticAttributes.CODE_FUNCTION}.results.orderLoopSkipped`]: true,
          })

          await this.strategy.closePosition()

          result.updatePositionSkipped = true
        } else {
          logger.debug("starting with order loop")

          const updatedPositionResult = await this.strategy.updatePosition(
            usdLiability,
            btcPriceInUsd,
          )
          result.updatedPositionResult = updatedPositionResult
          if (updatedPositionResult.ok) {
            const originalPosition = updatedPositionResult.value.originalPosition
            const updatedPosition = updatedPositionResult.value.updatedPosition

            addAttributesToCurrentSpan({
              [`${SemanticAttributes.CODE_FUNCTION}.results.updatePosition.success`]:
                true,
              [`${SemanticAttributes.CODE_FUNCTION}.results.updatePosition.originalPosition`]:
                JSON.stringify(originalPosition),
              [`${SemanticAttributes.CODE_FUNCTION}.results.updatePosition.updatedPosition`]:
                JSON.stringify(updatedPosition),
            })

            logger.info(
              {
                usdLiability,
                btcPriceInUsd,
                activeStrategy: this.strategy.name,
                originalPosition,
                updatedPosition,
              },
              "The {activeStrategy} was successful at UpdatePosition({usdLiability}, {btcPriceInUsd})",
            )
          } else {
            addAttributesToCurrentSpan({
              [`${SemanticAttributes.CODE_FUNCTION}.results.updatePosition.success`]:
                false,
              [`${SemanticAttributes.CODE_FUNCTION}.results.updatePosition.error`]:
                JSON.stringify(updatedPositionResult.error),
            })
            logger.error(
              {
                usdLiability,
                btcPriceInUsd,
                activeStrategy: this.strategy.name,
                updatedPosition: updatedPositionResult,
              },
              "The {activeStrategy} failed during the UpdatePosition({usdLiability}, {btcPriceInUsd}) execution",
            )
          }
        }

        // Check for any in-flight fund transfer, and skip if not all completed
        const dbCallResult = await database.inFlightTransfers.getPendingCount()
        if (dbCallResult.ok && dbCallResult.value === 0) {
          logger.debug("starting with rebalance loop")

          const withdrawOnChainAddressResult =
            await this.wallet.getWalletOnChainDepositAddress()
          logger.debug(
            { withdrawOnChainAddressResult },
            "wallet.getWalletOnChainDepositAddress() returned: {withdrawOnChainAddressResult}",
          )
          if (!withdrawOnChainAddressResult.ok || !withdrawOnChainAddressResult.value) {
            const message = "WalletOnChainAddress is unavailable or invalid."
            logger.debug({ withdrawOnChainAddressResult }, message)
            return { ok: false, error: new Error(message) }
          }
          const withdrawOnChainAddress = withdrawOnChainAddressResult.value

          const updatedLeverageResult = await this.strategy.updateLeverage(
            usdLiability,
            btcPriceInUsd,
            withdrawOnChainAddress,
            this.withdrawBookKeeping.bind(this),
            this.depositOnExchangeCallback.bind(this),
          )
          result.updatedLeverageResult = updatedLeverageResult
          if (updatedLeverageResult.ok) {
            const updatedLeverage = updatedLeverageResult.value

            addAttributesToCurrentSpan({
              [`${SemanticAttributes.CODE_FUNCTION}.results.updateLeverage.success`]:
                true,
              [`${SemanticAttributes.CODE_FUNCTION}.results.updateLeverage.updatedLeverage`]:
                JSON.stringify(updatedLeverage),
            })

            logger.info(
              {
                usdLiability,
                btcPriceInUsd,
                withdrawOnChainAddress,
                activeStrategy: this.strategy.name,
                updatedLeverage,
              },
              "The active {activeStrategy} was successful at UpdateLeverage({usdLiability}, {exposureInUsd}, {btcPriceInUsd}, {withdrawOnChainAddress})",
            )
          } else {
            addAttributesToCurrentSpan({
              [`${SemanticAttributes.CODE_FUNCTION}.results.updateLeverage.success`]:
                false,
              [`${SemanticAttributes.CODE_FUNCTION}.results.updateLeverage.error`]:
                JSON.stringify(updatedLeverageResult.error),
            })
            logger.error(
              {
                usdLiability,
                btcPriceInUsd,
                withdrawOnChainAddress,
                activeStrategy: this.strategy.name,
                updatedLeverageResult,
              },
              "The active {activeStrategy} failed during the UpdateLeverage({usdLiability}, {exposureInUsd}, {btcPriceInUsd}, {withdrawOnChainAddress}) execution",
            )
          }
        } else {
          addAttributesToCurrentSpan({
            [`${SemanticAttributes.CODE_FUNCTION}.results.rebalanceLoopSkipped`]: true,
          })

          result.updateLeverageSkipped = true
          if (dbCallResult.ok) {
            const pending = dbCallResult.value
            const message =
              "Some funds are in-flight, skipping the rebalance until settlement"
            logger.debug({ pending }, message)
          } else {
            const message = "Error getting in-flight fund transfer data"
            logger.error({ dbCallResult }, message)
          }
        }

        if (
          (result.updatePositionSkipped || result.updatedPositionResult.ok) &&
          (result.updateLeverageSkipped || result.updatedLeverageResult.ok)
        ) {
          return { ok: true, value: result }
        } else {
          const errors: Error[] = []
          if (!result.updatePositionSkipped && !result.updatedPositionResult.ok) {
            errors.push(result.updatedPositionResult.error)
            return { ok: false, error: result.updatedPositionResult.error }
          } else if (!result.updateLeverageSkipped && !result.updatedLeverageResult.ok) {
            errors.push(result.updatedLeverageResult.error)
            return { ok: false, error: result.updatedLeverageResult.error }
          } else {
            return {
              ok: false,
              error: new Error(`Unknown error: ${errors}`),
            }
          }
        }
      },
    )
    return ret as Result<UpdatedPositionAndLeverageResult>
  }

  private async depositOnExchangeCallback(
    onChainAddress: string,
    transferSizeInBtc: number,
    retries = 2,
  ): Promise<Result<void>> {
    try {
      const memo = `deposit of ${transferSizeInBtc} btc to ${this.strategy.name}`
      const transferSizeInSats = btc2sat(transferSizeInBtc)
      const payOnChainResult = await this.wallet.payOnChain(
        onChainAddress,
        transferSizeInSats,
        memo,
      )
      this.logger.debug(
        { payOnChainResult },
        "WalletOnChainPay returned: {payOnChainResult}",
      )

      if (payOnChainResult.ok) {
        // Persist in-flight fund transfer in database until completed
        const transfer: InFlightTransfer = {
          isDepositOnExchange: true,
          address: onChainAddress,
          transferSizeInSats,
          memo,
          isCompleted: false,
        }
        const result = await database.inFlightTransfers.insert(transfer)
        this.logger.debug(
          { result, transfer },
          "Insert in-flight fund transfer in database.",
        )
        if (!result.ok) {
          this.logger.error(
            { result },
            "Error while inserting in-flight fund transfer in database.",
          )
          return result
        }

        return { ok: true, value: undefined }
      } else {
        this.logger.debug({ payOnChainResult }, "WalletOnChainPay failed.")

        if (retries > 0) {
          // try again with 50% amount in case we can work around fund limit
          return this.depositOnExchangeCallback(
            onChainAddress,
            roundBtc(transferSizeInBtc / 2),
            retries - 1,
          )
        }

        return { ok: false, error: payOnChainResult.error }
      }
    } catch (error) {
      return { ok: false, error: error }
    }
  }

  private async withdrawBookKeeping(
    onChainAddress,
    transferSizeInBtc: number,
  ): Promise<Result<void>> {
    try {
      const memo = `withdrawal of ${transferSizeInBtc} btc from ${this.strategy.name}`
      const transferSizeInSats = btc2sat(transferSizeInBtc)
      this.logger.info({ transferSizeInSats, memo }, "withdrawBookKeeping")

      // Persist in-flight fund transfer in database until completed
      const transfer: InFlightTransfer = {
        isDepositOnExchange: false,
        address: onChainAddress,
        transferSizeInSats,
        memo,
        isCompleted: false,
      }
      const result = await database.inFlightTransfers.insert(transfer)
      this.logger.debug(
        { result, transfer },
        "Insert in-flight fund transfer in database.",
      )
      if (!result.ok) {
        this.logger.error(
          { result },
          "Error while inserting in-flight fund transfer in database.",
        )
        return result
      }

      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: error }
    }
  }

  public async getSpotPriceInUsd(): Promise<number> {
    const result = await this.strategy.getSpotPriceInUsd()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getMarkPriceInUsd(): Promise<number> {
    const result = await this.strategy.getMarkPriceInUsd()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getDerivativePriceInUsd(): Promise<number> {
    const result = await this.strategy.getDerivativePriceInUsd()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getDerivativeMarketInfo(): Promise<DerivativeMarketInfoResult> {
    const result = await this.strategy.getDerivativeMarketInfo()
    if (!result.ok) {
      return { askInUsd: NaN, bidInUsd: NaN }
    }
    return { askInUsd: result.value.askInUsd, bidInUsd: result.value.bidInUsd }
  }

  public async getNextFundingRateInBtc(): Promise<number> {
    const result = await this.strategy.getNextFundingRateInBtc()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getAccountAndPositionRisk(): Promise<
    Result<GetAccountAndPositionRiskResult>
  > {
    return this.strategy.getAccountAndPositionRisk()
  }

  public async getLiabilityInUsd(): Promise<number> {
    const result = await this.wallet.getUsdWalletBalance()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getLiabilityInBtc(): Promise<number> {
    const result = await this.wallet.getBtcWalletBalance()
    if (!result.ok) {
      return NaN
    }
    return result.value
  }

  public async getTradingFeesMetrics(): Promise<TradingFeesMetrics> {
    const result = await database.transactions.getTradingFeesMetrics()
    if (!result.ok) {
      return {} as TradingFeesMetrics
    }
    return result.value
  }

  public async getFundingFeesMetrics(): Promise<FundingFeesMetrics> {
    const result = await database.transactions.getFundingFeesMetrics()
    if (!result.ok) {
      return {} as FundingFeesMetrics
    }
    return result.value
  }

  public async getAnnualFundingYieldMetrics(): Promise<FundingYieldMetrics> {
    const ret: FundingYieldMetrics = {
      fundingYield1d: NaN,
      fundingYield1W: NaN,
      fundingYield2W: NaN,
      fundingYield3W: NaN,
      fundingYield1M: NaN,
      fundingYield2M: NaN,
      fundingYield3M: NaN,
      fundingYield6M: NaN,
      fundingYield1Y: NaN,
      fundingYield2Y: NaN,
      fundingYield3Y: NaN,
      fundingYield5Y: NaN,
    }
    const tenors = [
      { tenor: "1d", numberOfDays: 1 },
      { tenor: "1W", numberOfDays: 7 },
      { tenor: "2W", numberOfDays: 2 * 7 },
      { tenor: "3W", numberOfDays: 3 * 7 },
      { tenor: "1M", numberOfDays: 30 },
      { tenor: "2M", numberOfDays: 2 * 30 },
      { tenor: "3M", numberOfDays: 3 * 30 },
      { tenor: "6M", numberOfDays: 6 * 30 },
      { tenor: "1Y", numberOfDays: 365 },
      { tenor: "2Y", numberOfDays: 2 * 365 },
      { tenor: "3Y", numberOfDays: 3 * 365 },
      { tenor: "5Y", numberOfDays: 5 * 365 },
    ]
    for (const tenor of tenors) {
      const result = await database.fundingRates.getAnnualFundingYield(
        ExchangeNames.Okex,
        tenor.numberOfDays,
      )
      if (!result.ok) {
        return ret
      }
      ret[`fundingYield${tenor.tenor}`] = Number(result.value)
    }
    return ret
  }

  public async getFundingAccountBalance(): Promise<FetchFundingAccountBalanceResult> {
    const result = await this.strategy.getFundingAccountBalance()
    if (!result.ok) {
      return {
        btcFreeBalance: 0,
        btcUsedBalance: 0,
        btcTotalBalance: 0,
      } as FetchFundingAccountBalanceResult
    }
    return result.value
  }

  public async getExchangeStatus(): Promise<number> {
    const result = await this.strategy.fetchExchangeStatus()
    if (result.ok && result.value) {
      return 1
    }
    return -1
  }

  private async fetchTransactionHistory(
    args: GetTransactionHistoryParameters,
  ): Promise<Transaction[]> {
    const result = await this.strategy.fetchTransactionHistory(args)
    if (!result.ok) {
      return []
    }
    return result.value
  }

  public async fetchAndLoadTransactions() {
    // get latest id we saved in db
    let lastBillId = ""
    const result = await database.transactions.getLastBillId()
    if (!result.ok) {
      this.logger.error(
        "Couldn't get last transaction id from database, continuing with blank id...",
      )
    } else if (result.value) {
      lastBillId = result.value
    }

    // fetch and insert transactions since last
    const args: GetTransactionHistoryParameters = {
      beforeTransactionId: lastBillId,
    }
    const transactions = await this.fetchTransactionHistory(args)
    for (const transaction of transactions) {
      await database.transactions.insert(transaction)
    }
  }

  private async fetchFundingRateHistory(
    args: GetFundingRateHistoryParameters,
  ): Promise<FundingRate[]> {
    const result = await this.strategy.fetchFundingRateHistory(args)
    if (!result.ok) {
      return []
    }
    return result.value
  }

  public async fetchAndLoadFundingRates() {
    // get latest id we saved in db
    let lastFundingTime
    const result = await database.fundingRates.getLastFundingTime()
    if (!result.ok) {
      this.logger.error(
        "Couldn't get last fundingTime from database, continuing with blank id...",
      )
    } else if (result.value) {
      lastFundingTime = result.value
    }

    // fetch and insert fundingRates since last
    const args: GetFundingRateHistoryParameters = {
      beforeFundingTime: lastFundingTime,
    }
    const fundingRates = await this.fetchFundingRateHistory(args)
    for (const fundingRate of fundingRates) {
      await database.fundingRates.insert(fundingRate)
    }
  }
}
