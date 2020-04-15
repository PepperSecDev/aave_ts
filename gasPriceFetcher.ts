import fetch from "node-fetch";


export default class Fetcher {
  gasPrices: {
    fast: number,
    standard: number,
    low: number
    test: number
  }
  gasOracleUrls: string[]

  constructor() {
    this.gasPrices = {
      fast: 20,
      standard: 10,
      low: 1,
      test: 2.1
    }
    this.gasOracleUrls = ['https://ethgasstation.info/json/ethgasAPI.json', 'https://gas-oracle.zoltu.io/']
    this.fetchGasPrice()
  }

  async fetchGasPrice({ oracleIndex = 0 } = {}) {
    oracleIndex = (oracleIndex + 1) % this.gasOracleUrls.length
    const url = this.gasOracleUrls[oracleIndex]
    try {
      const response = await fetch(url)
      if (response.status === 200) {
        const json = await response.json()
        if (Number(json.fast) === 0) {
          throw new Error('Fetch gasPrice failed')
        }

        if (url === 'https://ethgasstation.info/json/ethgasAPI.json') {
          this.gasPrices.fast = Number(json.fast) / 10
          this.gasPrices.standard = Number(json.average) / 10
          this.gasPrices.low = Number(json.safeLow) / 10
        }

        if (url === 'https://gas-oracle.zoltu.io/') {
          this.gasPrices.fast = parseInt(json.percentile_90)
          this.gasPrices.standard = parseInt(json.percentile_60)
          this.gasPrices.low = parseInt(json.percentile_30)
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
