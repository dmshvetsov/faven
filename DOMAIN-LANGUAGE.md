Option class - is a underlying base asset and quote asset plus an asset that is used as a proxy for underlying in case if that assets is not present natively, like WBTC or HTBC that acts as physical delivery for BTC on Sui Network.

Option series - is a specific group of financial options contracts in a market that share the same type call or put, expiration date, and strike price for an option class.

Skew -  skewness measures the asymmetry in a frequency distribution, broadly means to distort, twist, or cause something to be asymmetrical, biased, or not straight.

Oracle SVI "a" parameter - The base volatility level. Higher a lifts the whole curve up. "a" moves the smile up/down.

Oracle SVI "b" parameter - The steepness of the curve. Higher b means volatility changes more aggressively as strike moves away from the center. "b" makes the smile sharper/flatter.

Oracle SVI "rho" parameter - The tilt / skew. It decides whether the curve leans more toward lower strikes or higher strikes. "rho" tilts the smile left/right.

Oracle SVI "m" parameter - The center point of the curve. It shifts the volatility “smile” left or right. "m" moves the center left/right.

Oracle SVI "sigma" parameter - The smoothness / width around the center. Higher sigma makes the middle of the curve wider and smoother. sigma controls how rounded the middle is.

Oracle SVI "k" parameter - mathematical version of moneyness `k = ln(strike / forward)`

Oracle "spot" price - current price of the assets know by Oracle, assume it lagging behind the real market price.

Oracle "forward" price - expected price by Oracle at time of expiry of the option.

Option "moneyness" - tells the model how far the contract is from ATM (at-the-money), ITM (in-the-moeny), OTM (out-the-money)

Notional value (or notional amount) - is the total underlying value of the assets an option contract controls. It represents your total market exposure and calculated by `= number of shares per contract * number of contracts * spot price`

In-the-money (ITM) - positive option "moneyness", when option underlying asset spot price is above option strike price for a call options and when asset spot price is below option strike price for a put option

At-the-money (ATM) - when option underlying asset spot price equals (or very close) the strike price.

Out-the-money (OTM) - negative option "moneyness", when option underlying asset spot price is below option strike price for call options and when option underlying asset spot price is above option strike price for put option.

Exercise by exception - is an administrative procedure used by clearinghouses that automatically exercises any in-the-money (ITM) options at expiration.

Stochastic Volatility Inspired (SVI) - parametric model used to smooth and model implied volatility smiles and surfaces. 

Volatility smile - is the pattern where options with different strikes have different implied volatility. I.e. BTC at 50k high implied volatility, 60k lower implied volatility, 70k high implied volatility while spot price is around 60k. Markets usually price extreme moves as more risky than a simple like standard deviation based model would suggest because far-away outcomes are not as impossible as basic math says.

The risk-free interest - rate is the theoretical return an investor would earn on an investment with zero risk of financial loss. Because no investment is truly 100% risk-free, in traditional finance analysts use short-term or long-term government bonds from stable economies as practical proxies.

TradFi - traditional, off-chain finance systems.

DeFi - decentralized on-chain finance systems.

Central Limit Order Book (CLOB) orderbook - a place that keep track of buyers placed bids, sellers placed asks, trades happen when bid price and ask price match.

DeepBook market key - combination of oracle, specific expiry and strike price. Can be a range key when instead of single strike price it has lower and upper strike.

RFQ (Request for Quote) - is an electronic process where a trader asks liquidity providers or market makers for a custom price on a specific trade. Instead of buying or selling directly from a public order book, you solicit competitive, private bids or offers before executing.

Monotonic - a progression, process, or mathematical value that strictly moves in a single, unchanging direction.

Fixed-point arithmetic - is a method of representing and calculating fractional numbers using integers by scaling all values by a fixed factor placing an implied decimal point in a predetermined position. 

Fixed-point token representation - uses fixed-point arithmetic, so fixed-point value 1100000: 1100000 is base unit aka "amount", has 6 decimals, 1.1 is display amount, 1 integer part, 0.1 fractional part

Checked arithmetic - are operations that verify whether a calculation exceeds (overflows) or falls below (underflows) the limits of a data type.

On-chain Protocol - it is software code that stored in a blockchain and called smart contract(s) with main purpose to execute predefined logic without external and/or central authority.

Mobile first - is a design and software development strategy that prioritizes creating software application user interfaces for mobile devices before adapting them for larger desktop screens.

PTB - programmable transaction block, a Sui blockchain transaction that can be grouped and broadcasted to Sui blockchain together as a single unit (execute all or nothing)

BSC (Binary Canonical Serialization) - Sui’s deterministic binary format for serializing signed data and transaction values.

EOA - externally owned account is a user-controlled blockchain wallet controlled by a private key.

Physical settlement of an option - is a process at contract expiration where the buyer and seller exchange the actual underlying asset rather than just transferring cash profits or losses.

Cash settlement of an option - is a mechanism in derivatives trading where a contract is resolved at expiration through a monetary exchange, rather than the physical delivery of the underlying asset.

BaseCoin - the physically delivered asset coin type, for example `SUI`, `DEEP`, `WBTC`, or another wrapped BTC coin.

QuoteCoin - the cash/strike/premium coin type, for example `USDC`.

OracleBase - the asset represented by the Pyth feed, for example `BTC` even when `BaseCoin` is `WBTC`.

Market - one deployed market instance for one `OracleBase / QuoteCoin / BaseCoin` combination.

LongToken - transferable semi-fungible option object with a `series_id` and `quantity`.

SellerVault - non-transferable seller short-position accounting record for one seller and one series.

CollateralPool - holds all `BaseCoin` and `QuoteCoin` collateral per series.

Series object - is the protocol’s shared accounting/state object for one option contract definition.
