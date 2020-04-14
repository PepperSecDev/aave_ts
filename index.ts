declare const process: { env: { [key: string]: string; }, exit: { (exitCode: number): void } }
require("dotenv").config();
import fetch from "node-fetch";
import "reflect-metadata";
import { plainToClass } from "class-transformer";
import Web3 from "web3";
import { fromWei, toChecksumAddress, numberToHex, toHex, toWei, hexToAscii } from "web3-utils";
import { CDP, ReservesData, Reserve, OneSplitReturn } from "./schemas"
import GasPriceFetcher from "./gasPriceFetcher"
import BigNumber from "bignumber.js";

const AAVE_LIQUIDATIONS = "https://protocol-api.aave.com/data/users/liquidations";

const fetcher = new GasPriceFetcher()
const { PRIVATE_KEY, GAS_PRICE, RPC_WSS_URL, LIQUIDATOR_ADDRESS } = process.env

const httpProvider = new Web3.providers.WebsocketProvider(RPC_WSS_URL);
const web3 = new Web3(httpProvider);
const account = web3.eth.accounts.privateKeyToAccount('0x' + PRIVATE_KEY)
web3.eth.accounts.wallet.add('0x' + PRIVATE_KEY)
web3.eth.defaultAccount = account.address

const LENDING_POOL_ABI = require("./abi/lendingPool.json");
const lendingPool = new web3.eth.Contract(
  LENDING_POOL_ABI,
  "0x398eC7346DcD622eDc5ae82352F02bE94C62d119"
);

const LIQUIDATOR_ABI = require('./abi/liquidator.json')
const flashLiquidator = new web3.eth.Contract(
  LIQUIDATOR_ABI,
  LIQUIDATOR_ADDRESS
);

const ONESPLIT_ADDRESS = "0xC586BeF4a0992C495Cf22e1aeEE4E446CECDee0E";
const ONESPLIT_ABI = require("./abi/oneSplit.json");
const oneSplit = new web3.eth.Contract(ONESPLIT_ABI, ONESPLIT_ADDRESS);

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SAI = "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKENS: Record<string, number> = {
  [WETH]: 0,
  [DAI]: 1,
  [USDC]: 2,
  [SAI]: 3,
};
function addressToMarketId(address: string): number | undefined {
  return TOKENS[toChecksumAddress(address)];
}

async function getCDPs(): Promise<CDP[]> {
  let cdps: CDP[] = []
  const result = await fetch(AAVE_LIQUIDATIONS, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });
  const jsonData = await result.json();

  for(let cdp of jsonData.data) {
    cdps.push(plainToClass(CDP, cdp))
  }

  return cdps
}

async function healthFactorFromContract(user: string): Promise<number> {
  const { healthFactor } = await lendingPool.methods
    .getUserAccountData(user)
    .call();
  return Number(fromWei(healthFactor));
}

async function getExpectedReturn(fromToken: string, toToken: string, amount: BigNumber): Promise<OneSplitReturn> {
  return new Promise((resolve, reject) => {
    const call = async (retryAttempt: number) => {
      retryAttempt++;
      try {
        let result = await oneSplit.methods
          .getExpectedReturn(fromToken, toToken, amount, 100, 0)
          .call();
        result = plainToClass(OneSplitReturn, result)
        resolve(result);
      } catch (e) {
        console.log("RPC failed. RetryAttempt is", retryAttempt, e.message);
        if (retryAttempt > 1) {
          reject(e);
        } else {
          call(retryAttempt);
        }
      }
    };
    call(0);
  });
}


function add5Percent(amount: BigNumber) {
  return amount.plus(amount.multipliedBy(5).dividedToIntegerBy(100));
}

async function prepareArgs(reserve: Reserve, borrowing: BigNumber, collateral: ReservesData) {
  borrowing = borrowing.multipliedBy(new BigNumber(10).pow(reserve.decimals))
  const collateralAmount = collateral.principalATokenBalance.multipliedBy(new BigNumber(10).pow(collateral.reserve.decimals))

  let distributionTo: string[] = [];
  let distributionFrom: string[] = [];
  let flashTokenId;
  const reserveMarketId = addressToMarketId(reserve.id);
  const collateralMarketId = addressToMarketId(collateral.reserve.id);
  let flashTokenAmount;
  if (reserveMarketId !== undefined) {
    console.log("we can get flash loan in reserve token");
    flashTokenId = reserveMarketId;
    const { distribution } = await getExpectedReturn(
      collateral.reserve.id,
      reserve.id,
      collateralAmount // TODO
    );
    distributionFrom = distribution;
    flashTokenAmount = borrowing; // TODO probably we should take a half
  } else if (collateralMarketId) {
    console.log("we can get flash loan in collateral token");
    flashTokenId = collateralMarketId;
    const { returnAmount, distribution } = await getExpectedReturn(
      collateral.reserve.id,
      reserve.id,
      collateralAmount // TODO we probably should exchange a half or so
    );
    distributionTo = distribution;
    flashTokenAmount = returnAmount;
  } else {
    console.log("lets take flash loan in WETH then");
    flashTokenId = addressToMarketId(WETH);
    // a rough calculation of how much WETH we need
    let { returnAmount } = await getExpectedReturn(
      reserve.id,
      WETH,
      borrowing
    );
    flashTokenAmount = add5Percent(returnAmount);

    // the distribution of the WETH to "reserve" swap
    let { distribution } = await getExpectedReturn(
      WETH,
      reserve.id,
      flashTokenAmount
    );
    distributionTo = distribution;

    // the distribution of the "collateral" to WETH swap
    ({ distribution } = await getExpectedReturn(
      collateral.reserve.id,
      WETH,
      collateralAmount // TODO we probably should exchange a half or so
    ));
    distributionFrom = distribution;
  }

  return {
    flashTokenId,
    flashTokenAmount,
    distributionTo,
    distributionFrom,
  };
}

async function liquidateTx(cdp: CDP) :Promise<any> {
  // console.log('cdp', cdp.user.reservesData)
  const reserve = cdp.reserve
  // console.log('reserve', reserve)
  const user = cdp.user

  let largestCollateral = user.reservesData[0]
  for (let {
    principalATokenBalance,
    reserve,
    currentUnderlyingBalanceUSD
  } of user.reservesData) {
    if (currentUnderlyingBalanceUSD.gt(largestCollateral.currentUnderlyingBalanceUSD)) {
      // console.log(
      //   `    ${principalATokenBalance} ${reserve.symbol} ($${currentUnderlyingBalanceUSD})`
      // );
      largestCollateral = {
        principalATokenBalance,
        reserve,
        currentUnderlyingBalanceUSD
      }
    }
  }

  // console.log('largestCollateral', largestCollateral)

  const {
    flashTokenId,
    flashTokenAmount,
    distributionTo,
    distributionFrom
  } = await prepareArgs(reserve, cdp.principalBorrows, largestCollateral)
  // console.log('distributionTo', distributionTo)
  // console.log('distributionFrom', distributionFrom)
  const data = await flashLiquidator.methods.liquidate(
    flashTokenId,
    flashTokenAmount,
    user.id,
    reserve.id,
    largestCollateral.reserve.id,
    distributionTo,
    distributionFrom
  ).encodeABI()

  let nonce = await web3.eth.getTransactionCount(account.address);
  const tx = {
    from: web3.eth.defaultAccount,
    value: "0x00",
    gas: numberToHex(2000000),
    gasPrice: toHex(toWei(fetcher.gasPrices.fast.toString(), "gwei")),
    to: LIQUIDATOR_ADDRESS,
    netId: 1,
    data,
    nonce,
  };

  return tx
}

async function main() {
  const cdps: CDP[] = await getCDPs();
  // console.log('cdps', cdps[0])
  let previousUser = null;
  for (let { principalBorrows, reserve, user } of cdps) {
    if (user.totalBorrowsUSD.gt(1) && user.healthFactor > 0) {
      const HF: number = await healthFactorFromContract(user.id);
      if (HF >= 1) continue; // outdated data
      if (previousUser === null) {
        previousUser = user.id;
      }
      if (previousUser !== user.id) {
        console.log("\n=================NEXT USER CDPs===============\n");
      } else {
        console.log("");
      }
      previousUser = user.id;

      console.log(
        `There is a CDP of ${principalBorrows} ${reserve.symbol} ${reserve.id} ($${user.totalBorrowsUSD})`
      );
      console.log("Colaterals are:");
      for (let {
        principalATokenBalance,
        reserve,
        currentUnderlyingBalanceUSD
      } of user.reservesData) {
        if (Number(principalATokenBalance) > 0) {
          console.log(
            `    ${principalATokenBalance} ${reserve.symbol} ${reserve.id} ($${currentUnderlyingBalanceUSD})`
          );
        }
      }
      console.log(`The healthFactor is ${user.healthFactor} (${HF})`);
      console.log(`User address is ${user.id}`);
      const tx = await liquidateTx({ principalBorrows, reserve, user })
      try {
        const gas = await web3.eth.estimateGas(tx);
        console.log("Gas required:", gas);
        let realProfit = await web3.eth.call(tx);
        console.log('realProfit', realProfit.toString())
      } catch (e) {
        console.error("Error: skipping tx ", e.message);
        const message = await web3.eth.call(tx);
        console.log("Error: Revert reason is", hexToAscii(toHex(message.toString())));
      } finally {
        console.log('The tx is\n', tx)
      }
    }
  }
  process.exit(0)
}

main();
