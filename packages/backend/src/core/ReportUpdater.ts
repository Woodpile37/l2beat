import { AssetId, UnixTime } from '@l2beat/common'

import { Token } from '../model'
import {
  BalanceRecord,
  BalanceRepository,
} from '../peripherals/database/BalanceRepository'
import {
  PriceRecord,
  PriceRepository,
} from '../peripherals/database/PriceRepository'
import {
  ReportRecord,
  ReportRepository,
} from '../peripherals/database/ReportRepository'

export class ReportUpdater {
  private tokenByAssetId = new Map<AssetId, Token>()
  private lastProcessed = new UnixTime(0)

  constructor(
    private priceRepository: PriceRepository,
    private balanceRepository: BalanceRepository,
    private reportRepository: ReportRepository,
    private tokens: Token[]
  ) {
    for (const token of this.tokens) {
      this.tokenByAssetId.set(token.id, token)
    }
  }

  async update(dataPoints: { timestamp: UnixTime; blockNumber: bigint }[]) {
    dataPoints = dataPoints.filter((x) => x.timestamp.gt(this.lastProcessed))
    for (const { timestamp, blockNumber } of dataPoints) {
      const [prices, balances] = await Promise.all([
        this.priceRepository.getByTimestamp(timestamp),
        this.balanceRepository.getByBlock(blockNumber),
      ])
      const tvlEntries = this.calculateTvls(prices, balances)
      this.reportRepository.addOrUpdate(tvlEntries)
      this.lastProcessed = timestamp
    }
  }

  calculateTvls(
    prices: PriceRecord[],
    balances: BalanceRecord[]
  ): ReportRecord[] {
    const priceMap = new Map(prices.map((p) => [p.coingeckoId, p]))
    const ethCoingeckoId = this.tokenByAssetId.get(AssetId.ETH)?.coingeckoId
    const ethPrice = ethCoingeckoId && priceMap.get(ethCoingeckoId)?.priceUsd

    if (!ethPrice) {
      return []
    }

    const tvls: ReportRecord[] = []
    for (const balance of balances) {
      const token = this.tokenByAssetId.get(balance.assetId)
      if (!token) {
        continue
      }
      const price = priceMap.get(token.coingeckoId)
      if (!price) {
        continue
      }
      tvls.push(calculateTVL(price, token.decimals, balance, ethPrice))
    }
    return tvls
  }
}

const ETH_PRECISION = 6n
const USD_PRECISION = 2n

export function calculateTVL(
  price: PriceRecord,
  decimals: number,
  balance: BalanceRecord,
  ethPrice: number
): ReportRecord {
  const bigintPrice = getBigIntPrice(price.priceUsd, decimals)
  const usdBalance = (balance.balance * bigintPrice) / 10n ** 18n
  const usdTVL = usdBalance / 10n ** (18n - USD_PRECISION)

  const etherBigInt = getBigIntPrice(ethPrice, 18)
  const etherBalance = (usdBalance * 10n ** 18n) / etherBigInt
  const ethTVL = etherBalance / 10n ** (18n - ETH_PRECISION)

  return {
    blockNumber: balance.blockNumber,
    timestamp: price.timestamp,
    bridge: balance.holderAddress,
    asset: balance.assetId,
    balance: balance.balance,
    usdTVL,
    ethTVL,
  }
}

export function getBigIntPrice(price: number, decimals: number) {
  const integerPart = BigInt(Math.floor(price)) * 10n ** 8n
  const fractionPart = BigInt(Math.floor((price % 1) * 100_000_000))
  const fixedPrice = integerPart + fractionPart
  return fixedPrice * 10n ** (18n * 2n - 8n - BigInt(decimals))
}
