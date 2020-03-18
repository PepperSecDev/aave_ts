require("dotenv").config();
import fetch, { Response } from "node-fetch";
import Web3 from "web3";
import { numberToHex, toHex, toWei, toBN, fromWei } from "web3-utils";

const AAVE_LIQUIDATIONS = "https://protocol-api.aave.com/data/users/liquidations";
const ORACLE_ABI = require("./abi.json");

const httpProvider = new Web3.providers.HttpProvider(
  <string>process.env.RPC_URL
);
const web3 = new Web3(httpProvider);
const lendingPool = new web3.eth.Contract(
  ORACLE_ABI,
  "0x398eC7346DcD622eDc5ae82352F02bE94C62d119"
);

interface CDP {
  principalBorrows: any;
  reserve: {
    symbol: string;
  };
  user: {
    totalBorrowsUSD: number;
    healthFactor: number;
    id: any;
    reservesData: any;
  };
}

interface HttpResponse extends Response {
  parsedBody?: any;
}

// async function getCDPs(): Promise<CDP[]> {
//   let result: Response = await fetch(AAVE_LIQUIDATIONS, {
//     method: "GET",
//     headers: {
//       "Content-Type": "application/json",
//       Accept: "application/json"
//     }
//   });
//   const jsonData = await result.json();
//   return jsonData.data;
// }

async function getCDPs(): Promise<CDP[]> {
  const result = await fetch(AAVE_LIQUIDATIONS, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });
  const jsonData = await result.json();
  return jsonData.data;
}

async function healthFactorFromContract(user: string): Promise<number> {
  const { healthFactor } = await lendingPool.methods
    .getUserAccountData(user)
    .call();
  return Number(fromWei(healthFactor));
}

async function main() {
  const cdps: CDP[] = await getCDPs();
  let previousUser = null;
  for (let { principalBorrows, reserve, user } of cdps) {
    console.log('user.totalBorrowsUSD', typeof user.totalBorrowsUSD)
    if (user.totalBorrowsUSD > 10 && user.healthFactor > 0.5) {
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
    }
  }
}

main();
