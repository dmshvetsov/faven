## Product features

| feature                                     | dependency              |
| --                                          | --                      |
| underwrite.generate tx API                  | no |
| seller buyer RFQ                            | no |
| public SDK exercise                         | no |
| exercise.generate tx API                    | no |
| indexer infra                               | no |
| indexer Long transfer                       | no |
| indexer underwrites                         | no |
| indexer exercises                           | no |
| indexer price finalization                  | no |
| indexer series settlement                   | no |
| live Long holders data                      | indexer Long underwrites, transfers, exercises |
| Long positions API                          | live long holders data  |
| WS API authorization                        | no |
| WS API authentication                       | no |
| Price finalization notification API         | no |
| exercises DB table?                         | no |
| underwrites DB table                        | no |
| options_series DB table                     | no |
| server API exercise backfill                | exercise DB table |
| server API underwrite backfill              | underwrites DB table |
| server API serie price finalization backfill| options_series DB table |
| server API serie settlemet backfill         | options_series DB table |
| internal SDK with business logic            | no |
| admin CLI exercise tx backfill              | internal SDK, Server API exercise backfill |
| admin CLI underwrite tx backfill            | internal SDK, Server API underwrite backfill |
| admin CLI pyth twap finalize tx backfill    | internal SDK, Server API price finalization backfill |
| admin CLI series settlement backfill        | internal SDK, Server API series settlement backfill |
| public SDK pyth twap finalize               | no |
| admin CLI series price finaliztion cmd      | SDK finalyze; Series DB list or HTTP API  |
| public SDK series settlement                | no |
| admin CLI series settlement                 | SDK series settlement; Series DB list or HTTP API |
