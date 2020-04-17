declare const process: { env: { [key: string]: string; }, exit: { (exitCode: number): void } }
require("dotenv").config();
import fetch from "node-fetch";
import "reflect-metadata";
import { plainToClass } from "class-transformer";
import Web3 from "web3";
import { fromWei, toChecksumAddress, numberToHex, toHex, toWei, hexToAscii } from "web3-utils";
import { CDP, ReservesData, Reserve, OneSplitReturn, User } from "./schemas"
import GasPriceFetcher from "./gasPriceFetcher"
import BigNumber from "bignumber.js";
const CoinGecko = require("coingecko-api");
const CoinGeckoClient = new CoinGecko();

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
}

function addressToMarketId(address: string): number {
  return TOKENS[toChecksumAddress(address)];
}

function marketIdToAddress(id: number) {
  for (let [ token, marketId ] of Object.entries(TOKENS)) {
    if (marketId === id) {
      return token
    }
  }
  return
}

async function getPriceInUSD(tokenAddress: string) {
  const arpa = await CoinGeckoClient.simple.fetchTokenPrice({
    contract_addresses: tokenAddress,
    vs_currencies: "usd",
    assetPlatform: "ethereum",
  });
  return arpa.data[tokenAddress.toLowerCase()].usd;
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
        if (retryAttempt > 20) {
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

  let beforeLiquidationSplit: string[] = [];
  let afterLiquidationSplit: string[] = [];
  let remaningReserveSplit: string[] = [];
  let flashTokenId: number;
  const reserveMarketId = addressToMarketId(reserve.id);
  const collateralMarketId = addressToMarketId(collateral.reserve.id);
  let flashTokenAmount;
  if (reserveMarketId !== undefined) {
    console.log("we can get flash loan in reserve token");
    flashTokenId = reserveMarketId;
    flashTokenAmount = borrowing; // TODO probably we should take a half
    const { distribution } = await getExpectedReturn(
      collateral.reserve.id,
      reserve.id,
      collateralAmount // TODO
    );
    afterLiquidationSplit = distribution;
  } else if (collateralMarketId) {
    console.log("we can get flash loan in collateral token");
    flashTokenId = collateralMarketId;
    flashTokenAmount = collateralAmount;
    let { distribution } = await getExpectedReturn(
      collateral.reserve.id,
      reserve.id,
      collateralAmount // TODO we probably should exchange a half or so
    );
    beforeLiquidationSplit = distribution;

    ({ distribution } = await getExpectedReturn(
      reserve.id,
      collateral.reserve.id,
      borrowing
    ));
    remaningReserveSplit = distribution;
  } else {
    console.log("lets take flash loan in WETH then");
    flashTokenId = addressToMarketId(WETH);
    // a rough calculation of how much WETH we need
    let { returnAmount, distribution } = await getExpectedReturn(
      reserve.id,
      WETH,
      borrowing
    );
    flashTokenAmount = add5Percent(returnAmount);
    // since we borrow more than we need, there will be so reserve leftovers, so we need to exchange them back
    remaningReserveSplit = distribution;

    // the distribution of the WETH to "reserve" swap
    ({ distribution } = await getExpectedReturn(
      WETH,
      reserve.id,
      flashTokenAmount
    ));
    beforeLiquidationSplit = distribution;

    // the distribution of the "collateral" to WETH swap
    ({ distribution } = await getExpectedReturn(
      collateral.reserve.id,
      WETH,
      collateralAmount // TODO we probably should exchange a half or so
    ));
    afterLiquidationSplit = distribution;
  }

  return {
    flashTokenId,
    flashTokenAmount,
    beforeLiquidationSplit,
    afterLiquidationSplit,
    remaningReserveSplit
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
    beforeLiquidationSplit,
    afterLiquidationSplit,
    remaningReserveSplit
  } = await prepareArgs(reserve, cdp.principalBorrows, largestCollateral)
  // console.log('beforeLiquidationSplit', beforeLiquidationSplit)
  // console.log('afterLiquidationSplit', afterLiquidationSplit)
  // console.log('afterLiquidationSplit', remaningReserveSplit)
  const data = await flashLiquidator.methods.liquidate(
    flashTokenId,
    flashTokenAmount,
    user.id,
    reserve.id,
    largestCollateral.reserve.id,
    beforeLiquidationSplit,
    afterLiquidationSplit,
    remaningReserveSplit
  ).encodeABI()

  let nonce = await web3.eth.getTransactionCount(account.address);
  const tx = {
    from: web3.eth.defaultAccount,
    value: "0x00",
    gas: numberToHex(3500000),
    gasPrice: toHex(toWei(fetcher.gasPrices.standard.toString(), "gwei")),
    to: LIQUIDATOR_ADDRESS,
    netId: 1,
    data,
    nonce,
  };

  return { tx, flashToken: marketIdToAddress(flashTokenId) }
}

function printCDP(previousUser: string, principalBorrows: BigNumber, reserve: Reserve, user: User, HF: number) {
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
}



async function main() {
  const cdps: CDP[] = await getCDPs();
  console.log(`Start processing new ${cdps.length} CDPs`)
  let previousUser = null;
  for (let { principalBorrows, reserve, user } of cdps) {
    if (user.totalBorrowsUSD.gt(5) && user.healthFactor > 0) {
      const HF: number = await healthFactorFromContract(user.id);
      if (HF >= 1) continue; // outdated data
      if (previousUser === null) {
        previousUser = user.id;
      }
      printCDP(previousUser, principalBorrows, reserve, user, HF)
      const { tx, flashToken } = await liquidateTx({ principalBorrows, reserve, user })
      try {
        const gas = new BigNumber(await web3.eth.estimateGas(tx));
        console.log("Gas required:", gas.toString());
        const realProfitHex = (await web3.eth.call(tx)).toString();
        let realProfit = Number(fromWei(
          realProfitHex,
          flashToken === USDC ? "picoether" : "ether" // usdc has 6 decimal
        ));
        const price = await getPriceInUSD(flashToken);
        realProfit = Number(price) * Number(realProfit);
        if (realProfit === Infinity) {
          throw new Error('eth_call failed');
        }
        console.log(`Real profit ${realProfit}`)

        const ethPrice = await getPriceInUSD(WETH);
        const expenceInWei = new BigNumber(toWei(fetcher.gasPrices.standard.toString(), "gwei"))
          .multipliedBy(gas)
          .toString();
        const expense =
          Number(fromWei(expenceInWei)) *
          ethPrice;
        console.log(`Tx cost $${expense}`);

        if (realProfit > expense + 0.2) {
          let signedTx = await web3.eth.accounts.signTransaction(
            tx,
            PRIVATE_KEY
          );
          let result = web3.eth.sendSignedTransaction(
            signedTx.rawTransaction!
          );
          result
            .once("transactionHash", function (txHash) {
              console.log(
                `Success: A new successfully sent tx https://etherscan.io/tx/${txHash}`
              );
            })
            .on("error", async function (e) {
              console.log("error", e.message);
            });
        }
      } catch (e) {
        console.error("Error: skipping tx ", e.message);
        const message = await web3.eth.call(tx);
        console.log("Error: Revert reason is", hexToAscii(toHex(message.toString())));
      } finally {
        tx.nonce = undefined
        tx.netId = undefined
        console.log('The tx is\n', JSON.stringify(tx))
      }
    }
  }
  console.log("Finished processing the whole aave market. Lets wait 60 sec and start again.")
  setTimeout(main, 60000)
}

main();
