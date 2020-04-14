import fetch from "node-fetch";


export default class Fetcher {
  gasPrices: {
    fast: number
  }
  gasOracleUrls: string[]

  constructor() {
    this.gasPrices = {
      fast: 20
    }
    this.gasOracleUrls = ['https://ethgasstation.info/json/ethgasAPI.json', 'https://gas-oracle.zoltu.io/']
    this.fetchGasPrice()
  }

  async fetchGasPrice({ oracleIndex = 0 } = {}) {
    oracleIndex = (oracleIndex + 1) % this.gasOracleUrls.length
    const url = this.gasOracleUrls[oracleIndex]
    const delimiter = url === 'https://ethgasstation.info/json/ethgasAPI.json' ? 10 : 1
    try {
      const response = await fetch(url)
      if (response.status === 200) {
        const json = await response.json()
        if (Number(json.fast) === 0) {
          throw new Error('Fetch gasPrice failed')
        }

        if (json.fast) {
          this.gasPrices.fast = Number(json.fast) / delimiter
        }

        if (json.percentile_97) {
          this.gasPrices.fast = parseInt(json.percentile_90) / delimiter
        }
        console.log('gas price fetch', this.gasPrices)
      } else {
        throw Error('Fetch gasPrice failed')
      }
      setTimeout(() => this.fetchGasPrice({ oracleIndex }), 15000)
    } catch (e) {
      setTimeout(() => this.fetchGasPrice({ oracleIndex }), 15000)
    }
  }
}
