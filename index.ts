declare var process: { env: { [key: string]: string; } }
require("dotenv").config();
import fetch from "node-fetch";
import "reflect-metadata";
import { plainToClass } from "class-transformer";
import Web3 from "web3";
import { fromWei } from "web3-utils";
import { CDP } from "./schemas"
import BigNumber from "bignumber.js";

const AAVE_LIQUIDATIONS = "https://protocol-api.aave.com/data/users/liquidations";
const ORACLE_ABI = require("./abi.json");
const RESERVES = require("./abi.json");
const { PRIVATE_KEY, GAS_PRICE, RPC_URL } = process.env

const httpProvider = new Web3.providers.HttpProvider(RPC_URL);
const web3 = new Web3(httpProvider);
const account = web3.eth.accounts.privateKeyToAccount('0x' + PRIVATE_KEY)
web3.eth.accounts.wallet.add('0x' + PRIVATE_KEY)
web3.eth.defaultAccount = account.address
const lendingPool = new web3.eth.Contract(
  ORACLE_ABI,
  "0x398eC7346DcD622eDc5ae82352F02bE94C62d119"
);

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

async function liquidate(cdp: CDP) :Promise<void> {
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

  const purchaseAmount = cdp.principalBorrows.times(reserve.decimals)
  const receiveAtoken = false // TODO: may be we should use it to optimize the gas
  // const data = await lendingPool.methods.liquidationCall(
  //   largestCollateral.reserve.id,
  //   reserve.id,
  //   user.id,
  //   purchaseAmount,
  //   receiveAtoken
  // ).encodeABI({
  //   value: etherValue
  // })
}

async function main() {
  const cdps: CDP[] = await getCDPs();
  // console.log('cdps', cdps[0])
  let previousUser = null;
  for (let { principalBorrows, reserve, user } of cdps) {
    if (user.totalBorrowsUSD.gt(0) && user.healthFactor > 0) {
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
        `There is a CDP of ${principalBorrows} ${reserve.symbol} ($${user.totalBorrowsUSD})`
      );
      console.log("Colaterals are:");
      for (let {
        principalATokenBalance,
        reserve,
        currentUnderlyingBalanceUSD
      } of user.reservesData) {
        if (Number(principalATokenBalance) > 0) {
          console.log(
            `    ${principalATokenBalance} ${reserve.symbol} ($${currentUnderlyingBalanceUSD})`
          );
        }
      }
      console.log(`The healthFactor is ${user.healthFactor} (${HF})`);
      console.log(`User address is ${user.id}`);
      await liquidate({ principalBorrows, reserve, user })
    }
  }
}

main();
