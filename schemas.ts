import { Type, Transform } from "class-transformer";
import { toChecksumAddress } from "web3-utils";
import BigNumber from "bignumber.js"


export class Reserve {
  @Type(() => String)
  symbol: string;

  @Type(() => BigNumber)
  decimals: BigNumber

  @Type(() => String)
  id: string;

  @Transform(value => toChecksumAddress(value), { toClassOnly: true })
  underlyingAsset: string;
}

export class ReservesData {
  @Transform(value => new BigNumber(value), { toClassOnly: true })
  principalATokenBalance: BigNumber

  @Type(() => Reserve)
  reserve: Reserve;

  @Transform(value => new BigNumber(value), { toClassOnly: true })
  currentUnderlyingBalanceUSD: BigNumber
}

export class User {
    @Transform(value => new BigNumber(value), { toClassOnly: true })
    totalBorrowsUSD: BigNumber;

    @Type(() => Number)
    healthFactor: number;

    @Transform(value => toChecksumAddress(value), { toClassOnly: true })
    id: string;

    @Type(() => ReservesData)
    reservesData: ReservesData[];
  }

export class CDP {
    @Transform(value => new BigNumber(value), { toClassOnly: true })
    principalBorrows: BigNumber;

    @Type(() => User)
    user: User;

    @Type(() => Reserve)
    reserve: Reserve;
  }

export class OneSplitReturn {
  @Transform(value => new BigNumber(value), { toClassOnly: true })
  returnAmount: BigNumber;

  // @Transform((values: BigNumber[]) => values.map(value => new BigNumber(value)), { toClassOnly: true })
  @Type(() => String)
  distribution: string[];
}

