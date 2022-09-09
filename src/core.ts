/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, log } from "@graphprotocol/graph-ts";
import {
  Pair,
  Token,
  NomiswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from "../generated/schema";
import { Mint, Burn, Swap, Transfer, Sync } from "../generated/templates/Pair/Pair";
import { updateNomiswapDayData, updatePairDayData, updatePairHourData, updateTokenDayData } from "./dayUpdates";
import { deriveUSDPrice, getTrackedVolumeUSD, getTrackedLiquidityUSD, getBnbPriceInUSD } from "./pricing";
import { convertTokenToDecimal, ADDRESS_ZERO, FACTORY_ADDRESS, ONE_BI, ZERO_BD, BI_18 } from "./utils";

function isCompleteMint(mintId: string): boolean {
  return (MintEvent.load(mintId) as MintEvent).sender !== null; // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // Initial liquidity.
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return;
  }

  // get pair and load contract
  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.debug("transfer event, but pair doesn't exist: {}", [event.address.toHex()])
    return
  }

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  if (event.params.from.toHex() == ADDRESS_ZERO) {
    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
          event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = event.params.to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on BNB withdrawals
  if (event.params.to.toHex() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
        event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.from.toHex() == pair.id) {
    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1]) as BurnEvent;
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
            event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString()));
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]) as MintEvent;
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.debug("sync event, but pair doesn't exist: {}", [event.address.toHex()])
    return
  }

  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.debug("sync event, but token0 doesn't exist: {}", [pair.token0])
    return
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.debug("sync event, but token1 doesn't exist: {}", [pair.token1])
    return
  }

  let factory = NomiswapFactory.load(FACTORY_ADDRESS);
  if (!factory) {
    log.debug("sync event, but factory doesn't exist: {}", [FACTORY_ADDRESS])
    return
  }

  let bundle = Bundle.load("1");
  if (!bundle) {
    log.debug("sync event, but bundle doesn't exist: {}", ["1"])
    return
  }

  const bnbPrice = getBnbPriceInUSD();
  bundle.bnbPrice = bnbPrice;
  bundle.save();

  // reset factory liquidity by subtracting only tracked liquidity
  factory.totalLiquidityUSD = factory.totalLiquidityUSD.minus(pair.trackedReserveUSD);
  factory.totalLiquidityBNB = factory.totalLiquidityBNB.minus(pair.trackedReserveBNB);

  // reset token total liquidity amounts
  // if this is the first SYNC event for this pair
  // then both reserves are 0 and this operation doesnt have an effect
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  // TODO: make constant
  // а что если сначала у нас была reserve0LiquidityUSD, а после текущей обработки евента - исчезнет (в условии снизу)
  // - это че, у нас останется висет старая reserve0LiquidityUSD?
  // проверяем что у пары определены цены токенов юсд
  // если они не определены - отнимать предыдущую trackedTotalLiquidity нет смысла - ведь ее и не было раньше 
  if (pair.reserve0LiquidityUSD.gt(ZERO_BD) && pair.reserve1LiquidityUSD.gt(ZERO_BD)) {
    token0.trackedTotalLiquidity = token0.trackedTotalLiquidity.minus(pair.reserve0)
    token0.trackedTotalLiquidityUSD = token0.trackedTotalLiquidityUSD.minus(pair.reserve0LiquidityUSD)

    token1.trackedTotalLiquidity = token1.trackedTotalLiquidity.minus(pair.reserve1)
    token1.trackedTotalLiquidityUSD = token1.trackedTotalLiquidityUSD.minus(pair.reserve1LiquidityUSD)
  }


  // updating pair reserves
  const reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  const reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  pair.reserve0 = reserve0;
  pair.reserve1 = reserve1;

  token0.totalLiquidity = token0.totalLiquidity.plus(reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(reserve1);

  pair.token0Price = reserve1.notEqual(ZERO_BD) ? reserve0.div(reserve1) : ZERO_BD;
  pair.token1Price = reserve0.notEqual(ZERO_BD) ? reserve1.div(reserve0) : ZERO_BD;


  // if (pair.id == "0x8e50d726e2ea87a27fa94760d4e65d58c3ad8b44") {
  //   log.warning("[sync] usdt-busd reserve0={} reserve1={} raw_reserve0={} raw_reserve1={} token0.decimals={} token1.decimals={}", [
  //     reserve0.toString(),
  //     reserve1.toString(),
  //     event.params.reserve0.toString(),
  //     event.params.reserve1.toString(),
  //     token0.decimals.toString(),
  //     token1.decimals.toString(),
  //   ])
  // }

  const deriveResponse = deriveUSDPrice(reserve0, reserve1, token0, token1)
  const token0UsdPrice = deriveResponse.token0PriceUsd; 
  const token1UsdPrice = deriveResponse.token1PriceUsd;
  const token0BnbPrice = bnbPrice.notEqual(ZERO_BD) ? token0UsdPrice.div(bnbPrice) : ZERO_BD;
  const token1BnbPrice = bnbPrice.notEqual(ZERO_BD) ? token1UsdPrice.div(bnbPrice) : ZERO_BD;

  // if (pair.id == "0x8e50d726e2ea87a27fa94760d4e65d58c3ad8b44") {
  //   log.warning("[sync] usdt-busd raw_reserve0={} raw_reserve1={} token0.decimals={} token1.decimals={}", [
  //     event.params.reserve0.toString(),
  //     event.params.reserve1.toString(),
  //     token0.decimals.toString(),
  //     token1.decimals.toString(),
  //   ])
  // }

  if (token0UsdPrice.gt(ZERO_BD) && token1UsdPrice.gt(ZERO_BD)) {
    log.info(
      "Pair new usd prices: pair={} token0UsdPrice={} token1UsdPrice={}", 
      [pair.id, token0UsdPrice.toString(),  token1UsdPrice.toString()]      
    )

    pair.reserve0LiquidityUSD = pair.reserve0.times(token0UsdPrice)
    pair.reserve1LiquidityUSD = pair.reserve1.times(token1UsdPrice)

    token0.trackedTotalLiquidity = token0.trackedTotalLiquidity.plus(reserve0)
    token1.trackedTotalLiquidity = token1.trackedTotalLiquidity.plus(reserve1)

    log.info(
      "pair={} token0.trackedTotalLiquidity={}", 
      [pair.id, token0.trackedTotalLiquidity.toString()+" +"+reserve0.toString()]      
    )
    log.info(
      "pair={} token1.trackedTotalLiquidity={}", 
      [pair.id, token1.trackedTotalLiquidity.toString()+" +"+reserve1.toString()]      
    )

    token0.trackedTotalLiquidityUSD = token0.trackedTotalLiquidityUSD.plus(pair.reserve0LiquidityUSD)
    token1.trackedTotalLiquidityUSD = token1.trackedTotalLiquidityUSD.plus(pair.reserve1LiquidityUSD)
    token0.derivedUSD = token0UsdPrice;
    token0.derivedBNB = token0BnbPrice;
    token1.derivedUSD = token1UsdPrice;
    token1.derivedBNB = token1BnbPrice;
  } else {
    log.debug("Pair zero liqudity pair={} token0UsdPrice={} token1UsdPrice={}", [
      pair.id,
      token0UsdPrice.toString(),
      token1UsdPrice.toString()
    ])
    pair.reserve0LiquidityUSD = ZERO_BD
    pair.reserve1LiquidityUSD = ZERO_BD
    // no need to subtract liqudity from tokens, as we subtracted it at the earlier step (if it was no 0)
  }

  // get tracked liquidity
  const trackedLiquidityUSD = getTrackedLiquidityUSD(reserve0, token0, reserve1, token1);
  const trackedLiquidityBNB = bnbPrice.notEqual(ZERO_BD) ? trackedLiquidityUSD.div(bnbPrice) : ZERO_BD;

  pair.trackedReserveUSD = trackedLiquidityUSD;
  pair.trackedReserveBNB = trackedLiquidityBNB;
  pair.reserveUSD = reserve0.times(token0UsdPrice)
      .plus(reserve1.times(token1UsdPrice));
  pair.reserveBNB = reserve0.times(token0BnbPrice)
      .plus(reserve1.times(token1BnbPrice));

  factory.totalLiquidityUSD = factory.totalLiquidityUSD.plus(trackedLiquidityUSD);
  factory.totalLiquidityBNB = factory.totalLiquidityBNB.plus(trackedLiquidityBNB);

  // TODO: price dilation

  token0.save()
  token1.save()
  pair.save()
  factory.save()
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (!transaction) {
    log.debug("mint event, but transaction doesn't exist: {}", [event.transaction.hash.toHex()])
    return
  }

  let mints = transaction.mints;
  let mint = MintEvent.load(mints[mints.length - 1]);
  if (!mint) {
    log.debug("mint event, but mint doesn't exist: {}", [mints[mints.length - 1]])
    return
  }

  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.debug("mint event, but pair doesn't exist: {}", [event.address.toHex()])
    return
  }

  let factory = NomiswapFactory.load(FACTORY_ADDRESS);
  if (!factory) {
    log.debug("mint event, but factory doesn't exist: {}", [FACTORY_ADDRESS])
    return
  }

  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.debug("mint event, but token0 doesn't exist: {}", [pair.token0])
    return
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.debug("mint event, but token1 doesn't exist: {}", [pair.token1])
    return
  }

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  let amountTotalUSD = token0.derivedUSD.times(token0Amount)
      .plus(token1.derivedUSD.times(token1Amount));

  // update txn counts
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  factory.totalTransactions = factory.totalTransactions.plus(ONE_BI);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  factory.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount;
  mint.amount1 = token1Amount;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD;
  mint.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updateNomiswapDayData(event);
  updateTokenDayData(token0, event);
  updateTokenDayData(token1, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    return;
  }

  let burns = transaction.burns;
  let burn = BurnEvent.load(burns[burns.length - 1]);
  if (!burn) {
    log.debug("burn event, but burn doesn't exist: {}", [burns[burns.length - 1]])
    return
  }

  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.debug("burn event, but pair doesn't exist: {}", [event.address.toHex()])
    return
  }

  let factory = NomiswapFactory.load(FACTORY_ADDRESS);
  if (!factory) {
    log.debug("burn event, but factory doesn't exist: {}", [FACTORY_ADDRESS])
    return
  }

  // update token info
  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.debug("burn event, but token0 doesn't exist: {}", [pair.token0])
    return
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.debug("burn event, but token1 doesn't exist: {}", [pair.token1])
    return
  }

  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  let amountTotalUSD = token0.derivedUSD.times(token0Amount)
      .plus(token1.derivedUSD.times(token1Amount));

  // update txn counts
  factory.totalTransactions = factory.totalTransactions.plus(ONE_BI);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  factory.save();

  // update burn
  burn.amount0 = token0Amount;
  burn.amount1 = token1Amount;
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD;
  burn.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updateNomiswapDayData(event);
  updateTokenDayData(token0, event);
  updateTokenDayData(token1, event);
}

export function handleSwap(event: Swap): void {
  const pair = Pair.load(event.address.toHex())
  if (!pair) {
    log.debug("swap event, but pair doesn't exist: {}", [event.address.toHex()])
    return
  }

  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.debug("swap event, but token0 doesn't exist: {}", [pair.token0])
    return
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.debug("swap event, but token1 doesn't exist: {}", [pair.token1])
    return
  }

  let bundle = Bundle.load("1");
  if (!bundle) {
    log.debug("swap event, but bundle doesn't exist: {}", ["1"])
    return
  }

  const amount0In  = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  const amount1In  = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  const amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  const amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  let trackedAmountUSD = getTrackedVolumeUSD(
    amount0Total,
    token0,
    amount1Total,
    token1,
  );

    // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);

  
  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);



  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let nomiswap = NomiswapFactory.load(FACTORY_ADDRESS)!;
  nomiswap.totalVolumeUSD = nomiswap.totalVolumeUSD.plus(trackedAmountUSD);
  nomiswap.totalTransactions = nomiswap.totalTransactions.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  nomiswap.save();

  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.swaps = [];
    transaction.mints = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(swaps.length).toString()));

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let nomiswapDayData = updateNomiswapDayData(event);
  let token0DayData = updateTokenDayData(token0, event);
  let token1DayData = updateTokenDayData(token1, event);

  // swap specific updating
  nomiswapDayData.dailyVolumeUSD = nomiswapDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  nomiswapDayData.totalVolumeUSD = nomiswap.totalVolumeUSD;
  nomiswapDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();
 
  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedUSD)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedUSD)
  );
  token1DayData.save();
}