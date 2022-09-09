/* eslint-disable prefer-const */
import { PairHourData } from "../generated/schema";
import { BigInt, BigDecimal, ethereum } from "@graphprotocol/graph-ts";
import { Pair, Token, NomiswapFactory, NomiswapDayData, PairDayData, TokenDayData } from "../generated/schema";
import { ONE_BI, ZERO_BD, ZERO_BI, FACTORY_ADDRESS } from "./utils";

export function updateNomiswapDayData(event: ethereum.Event): NomiswapDayData {
  let nomiswap = NomiswapFactory.load(FACTORY_ADDRESS)!;
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;

  let nomiswapDayData = NomiswapDayData.load(dayID.toString());
  if (nomiswapDayData === null) {
    nomiswapDayData = new NomiswapDayData(dayID.toString());
    nomiswapDayData.date = dayStartTimestamp;
    nomiswapDayData.dailyVolumeUSD = ZERO_BD;
    nomiswapDayData.totalVolumeUSD = ZERO_BD;

  }
  nomiswapDayData.totalLiquidityUSD = nomiswap.totalLiquidityUSD;
  nomiswapDayData.totalTransactions = nomiswap.totalTransactions;
  nomiswapDayData.save();

  return nomiswapDayData;
}

export function updatePairDayData(event: ethereum.Event): PairDayData {
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;
  let dayPairID = event.address.toHex().concat("-").concat(BigInt.fromI32(dayID).toString());
  let pair = Pair.load(event.address.toHex())!;
  let pairDayData = PairDayData.load(dayPairID);
  if (pairDayData === null) {
    pairDayData = new PairDayData(dayPairID);
    pairDayData.date = dayStartTimestamp;
    pairDayData.token0 = pair.token0;
    pairDayData.token1 = pair.token1;
    pairDayData.pairAddress = event.address;
    pairDayData.dailyVolumeToken0 = ZERO_BD;
    pairDayData.dailyVolumeToken1 = ZERO_BD;
    pairDayData.dailyVolumeUSD = ZERO_BD;
    pairDayData.dailyTxns = ZERO_BI;
    pairDayData.totalSupply = ZERO_BD;
  }
  pairDayData.reserve0 = pair.reserve0;
  pairDayData.reserve1 = pair.reserve1;
  pairDayData.reserveUSD = pair.reserve0LiquidityUSD.plus(pair.reserve1LiquidityUSD);
  pairDayData.dailyTxns = pairDayData.dailyTxns.plus(ONE_BI);
  pairDayData.save();

  return pairDayData as PairDayData;
}

export function updatePairHourData(event: ethereum.Event): PairHourData {
  let timestamp = event.block.timestamp.toI32();
  let hourIndex = timestamp / 3600;
  let hourStartUnix = hourIndex * 3600;
  let hourPairID = event.address.toHex().concat("-").concat(BigInt.fromI32(hourIndex).toString());
  let pair = Pair.load(event.address.toHex())!;
  let pairHourData = PairHourData.load(hourPairID);
  if (pairHourData === null) {
    pairHourData = new PairHourData(hourPairID);
    pairHourData.hourStartUnix = hourStartUnix;
    pairHourData.pair = event.address.toHex();
    pairHourData.hourlyVolumeToken0 = ZERO_BD;
    pairHourData.hourlyVolumeToken1 = ZERO_BD;
    pairHourData.hourlyVolumeUSD = ZERO_BD;
    pairHourData.hourlyTxns = ZERO_BI;
  }
  pairHourData.totalSupply = ZERO_BD;
  pairHourData.reserve0 = pair.reserve0;
  pairHourData.reserve1 = pair.reserve1;
  pairHourData.reserveUSD = pair.reserve0LiquidityUSD.plus(pair.reserve1LiquidityUSD);;
  pairHourData.hourlyTxns = pairHourData.hourlyTxns.plus(ONE_BI);
  pairHourData.save();

  return pairHourData as PairHourData;
}

export function updateTokenDayData(token: Token, event: ethereum.Event): TokenDayData {
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;
  let tokenDayID = token.id.toString().concat("-").concat(BigInt.fromI32(dayID).toString());

  let tokenDayData = TokenDayData.load(tokenDayID);
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID);
    tokenDayData.date = dayStartTimestamp;
    tokenDayData.token = token.id;
    tokenDayData.priceUSD = token.derivedUSD;
    tokenDayData.dailyVolumeToken = ZERO_BD;
    tokenDayData.dailyVolumeUSD = ZERO_BD;
    tokenDayData.dailyTxns = ZERO_BI;
    tokenDayData.totalLiquidityUSD = ZERO_BD;
  }
  // TODO: maybe it'll be more correct to use mean price
  tokenDayData.priceUSD = token.derivedUSD;
  tokenDayData.totalLiquidityToken = token.totalLiquidity;
//   tokenDayData.totalLiquidityBNB = token.totalLiquidity.times(token.derivedBNB as BigDecimal);
  tokenDayData.totalLiquidityUSD = token.trackedTotalLiquidityUSD;
  tokenDayData.dailyTxns = tokenDayData.dailyTxns.plus(ONE_BI);
  tokenDayData.save();

  return tokenDayData as TokenDayData;
}