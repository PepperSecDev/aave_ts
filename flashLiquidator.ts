require("dotenv").config();
import fetch from "node-fetch";
import Web3 from "web3";

const AAVE_SUBGRAPH = "https://api.thegraph.com/subgraphs/name/aave/protocol-raw";

declare const process: { env: { [key: string]: string; }, exit: { (exitCode: number): void } }
const { PRIVATE_KEY, GAS_PRICE, RPC_WSS_URL, LIQUIDATOR_ADDRESS } = process.env

const httpProvider = new Web3.providers.WebsocketProvider(RPC_WSS_URL);
const web3 = new Web3(httpProvider);
const account = web3.eth.accounts.privateKeyToAccount('0x' + PRIVATE_KEY)
web3.eth.accounts.wallet.add('0x' + PRIVATE_KEY)
web3.eth.defaultAccount = account.address
const LIQUIDATOR_ABI = require('./liquidator.ABI.json')
const flashLiquidator = new web3.eth.Contract(
  LIQUIDATOR_ABI,
  LIQUIDATOR_ADDRESS
);

async function getUsers(from: number, count: number): Promise<string[]> {
  let users: string[] = []
  const result = await fetch(AAVE_SUBGRAPH, {
    "headers": {
        "content-type": "application/json",
    },
    "body": `{\"query\":\"{\\n  userReserves(first: ${count}, skip: ${from} where: {principalBorrows_gt: 0}) {\\n    principalBorrows\\n    user {\\n      id\\n    }\\n    reserve {\\n      id\\n      symbol\\n    }\\n  }\\n}\",\"variables\":null}`,
    "method": "POST",
  });
  const jsonData = await result.json();
  for(let borrow of jsonData.data.userReserves) {
    if (users[users.length - 1] !== borrow.user.id) {
      users.push(borrow.user.id)
    }
  }
  return users
}

async function main() {
  const users = await getUsers(300, 1)
  console.log('users', users)
  for(let address of users) {
    let profit, gas
    try {
      gas = await flashLiquidator.methods.liquidate(address).estimateGas()
      profit = await flashLiquidator.methods.liquidate(address).call()
      // const expense = toBN(toWei(gasPrices.fast.toString(), 'gwei')).mul(toBN(gas))
      console.log(`Address ${address}`)
      console.log('profit', profit, gas)
    } catch (e) {
      console.log(`Address ${address} failed`)
    }
    // console.log('profit', toHex(profit))
  }
  process.exit(0)
}

main()


// async function checkOne() {
//   const address = '0x3e231F88C2c2cAcFf7642930a11A2AB823ef0E88'
//   let profit, data, gas
//   try {
//     profit = await flashLiquidator.methods.liquidate(address).call( { gas: '7000000'})
//     gas = await flashLiquidator.methods.liquidate(address).estimateGas()
//     // data = await flashLiquidator.methods.liquidate(address).encodeABI()
//     // console.log('data', data)
//     console.log(`Address ${address}`)
//     console.log('profit', profit)
//   } catch (e) {
//     // console.error(e)
//     console.log(`Address ${address} failed`)
//   }
// }

// checkOne()
